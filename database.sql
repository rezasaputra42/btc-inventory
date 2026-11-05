-- =====================================================================
-- BTC INVENTORY - Struktur database + aturan stok (Supabase / PostgreSQL)
-- ---------------------------------------------------------------------
-- CARA PAKAI: salin SELURUH isi file ini, tempel di Supabase
-- (menu "SQL Editor" -> "New query"), lalu tekan "Run" SATU KALI.
-- Aman dijalankan ulang bila terjadi kesalahan di tengah jalan.
--
-- Prinsip keamanan stok:
--   1. Semua perubahan stok HANYA lewat fungsi database (post_transaction,
--      opname_finalize, void_transaction). Aplikasi tidak bisa mengubah
--      angka stok secara langsung.
--   2. Setiap fungsi mengunci baris stok (FOR UPDATE) sebelum menghitung,
--      sehingga dua orang yang keluar-barang bersamaan tidak bisa membuat
--      stok negatif.
--   3. Kolom stok dipasangi CHECK (>= 0) sebagai pengaman terakhir.
--   4. Catatan transaksi & kartu stok bersifat permanen (tidak bisa
--      diubah/dihapus). Koreksi dilakukan lewat pembatalan (void) atau opname.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. FUNGSI UMUM
-- ---------------------------------------------------------------------

-- Tanggal hari ini menurut WIB (Palembang). Dipakai sebagai tanggal transaksi.
create or replace function public.today_wib()
returns date
language sql stable
as $$ select (now() at time zone 'Asia/Jakarta')::date $$;


-- ---------------------------------------------------------------------
-- 1. PENGGUNA & HAK AKSES
-- Peran: admin | supervisor | staff | viewer
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  full_name   text,
  role        text not null default 'viewer'
              check (role in ('admin', 'supervisor', 'staff', 'viewer')),
  is_active   boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Peran pengguna yang sedang login (NULL bila belum aktif / belum login)
create or replace function public.current_user_role()
returns text
language sql stable security definer
set search_path = public, pg_temp
as $$
  select p.role from public.profiles p
  where p.id = auth.uid() and p.is_active
$$;

-- Pastikan pengguna aktif dan perannya termasuk daftar yang diizinkan
create or replace function public.assert_role(p_roles text[])
returns text
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
begin
  if auth.uid() is null then
    raise exception 'Silakan login terlebih dahulu.';
  end if;
  v_role := public.current_user_role();
  if v_role is null then
    raise exception 'Akun Anda belum aktif. Hubungi admin gudang.';
  end if;
  if not (v_role = any (p_roles)) then
    raise exception 'Anda tidak memiliki hak akses untuk tindakan ini (peran Anda: %).', v_role;
  end if;
  return v_role;
end;
$$;

-- Setiap akun baru otomatis dibuatkan profil.
-- Akun PERTAMA yang mendaftar otomatis menjadi ADMIN aktif.
-- Akun berikutnya berstatus "menunggu persetujuan" sampai diaktifkan admin.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_first boolean;
begin
  perform pg_advisory_xact_lock(727001);
  select not exists (select 1 from public.profiles) into v_first;
  insert into public.profiles (id, email, full_name, role, is_active)
  values (
    new.id,
    new.email,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1)),
    case when v_first then 'admin' else 'viewer' end,
    v_first
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Jika sudah ada akun sebelum SQL ini dijalankan: buatkan profilnya,
-- dan jadikan akun tertua sebagai admin bila belum ada admin.
insert into public.profiles (id, email, full_name, role, is_active, created_at)
select u.id, u.email, split_part(u.email, '@', 1), 'viewer', false, u.created_at
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

update public.profiles
set role = 'admin', is_active = true
where id = (select id from public.profiles order by created_at limit 1)
  and not exists (select 1 from public.profiles where role = 'admin' and is_active);


-- ---------------------------------------------------------------------
-- 2. MASTER SKU
-- ---------------------------------------------------------------------
create table if not exists public.skus (
  id               uuid primary key default gen_random_uuid(),
  sku_code         text not null,
  barcode          text,                       -- barcode satuan (pcs)
  barcode_carton   text,                       -- barcode dus / karton
  name             text not null,
  category         text,
  unit             text not null default 'PCS',
  units_per_carton integer not null default 1 check (units_per_carton >= 1),
  min_stock        integer not null default 0 check (min_stock >= 0),
  is_active        boolean not null default true,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

drop index if exists public.skus_code_uq;
create unique index if not exists skus_code_uq on public.skus (sku_code);
create unique index if not exists skus_barcode_uq on public.skus (barcode) where barcode is not null;
create unique index if not exists skus_barcode_carton_uq on public.skus (barcode_carton) where barcode_carton is not null;
create index if not exists skus_name_idx on public.skus (lower(name));

-- Merapikan data SKU sebelum disimpan + cek barcode tidak bentrok
create or replace function public.skus_before_write()
returns trigger
language plpgsql
as $$
begin
  new.sku_code       := upper(trim(coalesce(new.sku_code, '')));
  new.name           := trim(coalesce(new.name, ''));
  new.barcode        := nullif(trim(coalesce(new.barcode, '')), '');
  new.barcode_carton := nullif(trim(coalesce(new.barcode_carton, '')), '');
  new.category       := nullif(trim(coalesce(new.category, '')), '');
  new.unit           := coalesce(nullif(trim(coalesce(new.unit, '')), ''), 'PCS');

  if new.sku_code = '' then raise exception 'Kode SKU wajib diisi.'; end if;
  if new.name = '' then raise exception 'Nama barang wajib diisi.'; end if;

  if new.barcode is not null and new.barcode = new.barcode_carton then
    raise exception 'Barcode satuan dan barcode dus tidak boleh sama.';
  end if;
  if new.barcode is not null and exists (
       select 1 from public.skus s where s.id <> new.id and s.barcode_carton = new.barcode) then
    raise exception 'Barcode % sudah dipakai sebagai barcode dus pada SKU lain.', new.barcode;
  end if;
  if new.barcode_carton is not null and exists (
       select 1 from public.skus s where s.id <> new.id and s.barcode = new.barcode_carton) then
    raise exception 'Barcode dus % sudah dipakai sebagai barcode satuan pada SKU lain.', new.barcode_carton;
  end if;

  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists skus_before_write on public.skus;
create trigger skus_before_write
  before insert or update on public.skus
  for each row execute function public.skus_before_write();


-- ---------------------------------------------------------------------
-- 3. SALDO STOK (dua keranjang: BAGUS dan RUSAK) - tidak boleh negatif
-- ---------------------------------------------------------------------
create table if not exists public.stock_balances (
  sku_id       uuid primary key references public.skus (id) on delete restrict,
  qty_good     integer not null default 0 check (qty_good >= 0),
  qty_damaged  integer not null default 0 check (qty_damaged >= 0),
  updated_at   timestamptz not null default now()
);

-- Setiap SKU baru otomatis punya baris saldo (0, 0)
create or replace function public.skus_after_insert()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.stock_balances (sku_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists skus_after_insert on public.skus;
create trigger skus_after_insert
  after insert on public.skus
  for each row execute function public.skus_after_insert();

insert into public.stock_balances (sku_id)
select s.id from public.skus s
where not exists (select 1 from public.stock_balances b where b.sku_id = s.id);


-- ---------------------------------------------------------------------
-- 4. TRANSAKSI (header) dan KARTU STOK (baris pergerakan)
-- Jenis: inbound | outbound | return_good | return_damaged |
--        dispose_damaged | opname | void
-- ---------------------------------------------------------------------
create sequence if not exists public.seq_trx_no;
create sequence if not exists public.seq_opname_no;

create table if not exists public.transactions (
  id               uuid primary key default gen_random_uuid(),
  trx_no           text not null unique,
  trx_type         text not null
                   check (trx_type in ('inbound','outbound','return_good','return_damaged',
                                       'dispose_damaged','opname','void')),
  trx_date         date not null,
  reference_no     text,
  party            text,
  notes            text,
  client_ref       uuid unique,            -- pencegah transaksi ganda (sinyal buruk / tekan 2x)
  total_qty        bigint not null default 0,
  line_count       integer not null default 0,
  void_of          uuid references public.transactions (id),
  voided_at        timestamptz,
  voided_by        uuid,
  voided_by_name   text,
  void_reason      text,
  created_by       uuid,
  created_by_name  text,
  created_at       timestamptz not null default now()
);
create index if not exists transactions_date_idx on public.transactions (trx_date desc, created_at desc);
create index if not exists transactions_type_idx on public.transactions (trx_type);
create index if not exists transactions_created_idx on public.transactions (created_at desc);

create table if not exists public.stock_movements (
  id              bigint generated always as identity primary key,
  transaction_id  uuid not null references public.transactions (id),
  sku_id          uuid not null references public.skus (id),
  bucket          text not null check (bucket in ('good', 'damaged')),
  qty_change      integer not null check (qty_change <> 0),
  balance_after   integer not null check (balance_after >= 0),
  trx_date        date not null,
  trx_type        text not null,
  created_at      timestamptz not null default now()
);
create index if not exists movements_sku_idx  on public.stock_movements (sku_id, bucket, id);
create index if not exists movements_date_idx on public.stock_movements (trx_date, trx_type);
create index if not exists movements_trx_idx  on public.stock_movements (transaction_id);

-- Catatan permanen: kartu stok tidak boleh diubah / dihapus
create or replace function public.block_changes()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Catatan % bersifat permanen dan tidak boleh diubah atau dihapus.', tg_table_name;
end;
$$;

drop trigger if exists stock_movements_immutable on public.stock_movements;
create trigger stock_movements_immutable
  before update or delete on public.stock_movements
  for each row execute function public.block_changes();

drop trigger if exists stock_movements_no_truncate on public.stock_movements;
create trigger stock_movements_no_truncate
  before truncate on public.stock_movements
  for each statement execute function public.block_changes();

-- Header transaksi: hanya kolom total & tanda pembatalan yang boleh terisi
create or replace function public.transactions_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Transaksi tidak boleh dihapus. Gunakan fitur pembatalan.';
  end if;
  if (new.id, new.trx_no, new.trx_type, new.trx_date, new.reference_no, new.party, new.notes,
      new.client_ref, new.void_of, new.created_by, new.created_by_name, new.created_at)
     is distinct from
     (old.id, old.trx_no, old.trx_type, old.trx_date, old.reference_no, old.party, old.notes,
      old.client_ref, old.void_of, old.created_by, old.created_by_name, old.created_at) then
    raise exception 'Isi transaksi tidak boleh diubah.';
  end if;
  if old.voided_at is not null and
     (new.voided_at is distinct from old.voided_at or new.void_reason is distinct from old.void_reason) then
    raise exception 'Transaksi ini sudah dibatalkan.';
  end if;
  return new;
end;
$$;

drop trigger if exists transactions_guard on public.transactions;
create trigger transactions_guard
  before update or delete on public.transactions
  for each row execute function public.transactions_guard();

drop trigger if exists transactions_no_truncate on public.transactions;
create trigger transactions_no_truncate
  before truncate on public.transactions
  for each statement execute function public.block_changes();


-- ---------------------------------------------------------------------
-- 5. STOCK OPNAME
-- ---------------------------------------------------------------------
create table if not exists public.stock_opnames (
  id                uuid primary key default gen_random_uuid(),
  opname_no         text not null unique,
  opname_date       date not null,
  notes             text,
  status            text not null default 'draft' check (status in ('draft','final','cancelled')),
  created_by        uuid,
  created_by_name   text,
  created_at        timestamptz not null default now(),
  finalized_by_name text,
  finalized_at      timestamptz,
  trx_id            uuid references public.transactions (id)
);

create table if not exists public.stock_opname_items (
  opname_id        uuid not null references public.stock_opnames (id) on delete cascade,
  sku_id           uuid not null references public.skus (id),
  counted_good     integer check (counted_good >= 0),
  counted_damaged  integer check (counted_damaged >= 0),
  system_good      integer,                 -- diisi saat finalisasi
  system_damaged   integer,                 -- diisi saat finalisasi
  counted_by_name  text,
  updated_at       timestamptz not null default now(),
  primary key (opname_id, sku_id)
);


-- ---------------------------------------------------------------------
-- 6. FUNGSI TRANSAKSI (satu-satunya jalan mengubah stok)
-- ---------------------------------------------------------------------

-- 6a. Barang masuk / keluar / retur bagus / retur rusak / keluarkan stok rusak
--     p_items contoh: [{"sku_id":"...","qty":12}, ...]  (qty dalam satuan terkecil)
create or replace function public.post_transaction(
  p_type       text,
  p_reference  text,
  p_party      text,
  p_notes      text,
  p_items      jsonb,
  p_client_ref uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_name    text;
  v_today   date := public.today_wib();
  v_bucket  text;
  v_sign    integer;
  v_prefix  text;
  v_trx_id  uuid;
  v_trx_no  text;
  v_total   bigint;
  v_lines   integer;
  r         record;
  b         record;
  v_cur     integer;
  v_new     integer;
begin
  if p_type in ('inbound', 'outbound', 'return_good', 'return_damaged') then
    perform public.assert_role(array['admin', 'supervisor', 'staff']);
  elsif p_type = 'dispose_damaged' then
    perform public.assert_role(array['admin', 'supervisor']);
  else
    raise exception 'Jenis transaksi tidak dikenal: %', p_type;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Daftar barang masih kosong.';
  end if;

  -- Kiriman ulang dari HP yang sama -> kembalikan hasil lama, jangan catat dua kali
  if p_client_ref is not null then
    select t.id, t.trx_no into v_trx_id, v_trx_no
    from public.transactions t where t.client_ref = p_client_ref;
    if found then
      return jsonb_build_object('id', v_trx_id, 'trx_no', v_trx_no, 'duplicate', true);
    end if;
  end if;

  select case p_type when 'inbound' then 'good' when 'outbound' then 'good'
                     when 'return_good' then 'good' else 'damaged' end,
         case p_type when 'inbound' then 1 when 'return_good' then 1
                     when 'return_damaged' then 1 else -1 end,
         case p_type when 'inbound' then 'IN' when 'outbound' then 'OUT'
                     when 'return_good' then 'RTB' when 'return_damaged' then 'RTR'
                     else 'DSP' end
    into v_bucket, v_sign, v_prefix;

  -- Gabungkan baris SKU yang sama, hitung total
  select coalesce(sum(x.q), 0), count(*) into v_total, v_lines
  from (
    select (e ->> 'sku_id')::uuid as sku_id, sum((e ->> 'qty')::bigint) as q
    from jsonb_array_elements(p_items) e
    group by 1
  ) x;

  select p.full_name into v_name from public.profiles p where p.id = v_uid;

  v_trx_no := v_prefix || '-' || to_char(v_today, 'YYMMDD') || '-' ||
              lpad(nextval('public.seq_trx_no')::text, 5, '0');

  begin
    insert into public.transactions
      (trx_no, trx_type, trx_date, reference_no, party, notes, client_ref,
       total_qty, line_count, created_by, created_by_name)
    values
      (v_trx_no, p_type, v_today, nullif(trim(p_reference), ''), nullif(trim(p_party), ''),
       nullif(trim(p_notes), ''), p_client_ref, v_total, v_lines, v_uid, v_name)
    returning id into v_trx_id;
  exception when unique_violation then
    select t.id, t.trx_no into v_trx_id, v_trx_no
    from public.transactions t where t.client_ref = p_client_ref;
    if found then
      return jsonb_build_object('id', v_trx_id, 'trx_no', v_trx_no, 'duplicate', true);
    end if;
    raise;
  end;

  -- Proses barang satu per satu, urut sku_id (urutan kunci sama -> tidak saling menunggu / deadlock)
  for r in
    select (e ->> 'sku_id')::uuid as sku_id, sum((e ->> 'qty')::bigint) as qty
    from jsonb_array_elements(p_items) e
    group by 1
    order by 1
  loop
    if r.sku_id is null then
      raise exception 'Data barang tidak valid.';
    end if;
    if r.qty is null or r.qty <= 0 then
      raise exception 'Jumlah barang harus lebih dari 0.';
    end if;
    if r.qty > 100000000 then
      raise exception 'Jumlah barang terlalu besar.';
    end if;

    select s.sku_code, s.name, s.is_active into b from public.skus s where s.id = r.sku_id;
    if not found then
      raise exception 'Barang tidak ditemukan di master SKU.';
    end if;
    if not b.is_active and p_type <> 'dispose_damaged' then
      raise exception 'SKU % - % sudah dinonaktifkan.', b.sku_code, b.name;
    end if;

    -- KUNCI baris stok: transaksi lain pada SKU ini menunggu sampai selesai
    if v_bucket = 'good' then
      select sb.qty_good into v_cur from public.stock_balances sb where sb.sku_id = r.sku_id for update;
    else
      select sb.qty_damaged into v_cur from public.stock_balances sb where sb.sku_id = r.sku_id for update;
    end if;
    if not found then
      insert into public.stock_balances (sku_id) values (r.sku_id) on conflict do nothing;
      if v_bucket = 'good' then
        select sb.qty_good into v_cur from public.stock_balances sb where sb.sku_id = r.sku_id for update;
      else
        select sb.qty_damaged into v_cur from public.stock_balances sb where sb.sku_id = r.sku_id for update;
      end if;
    end if;

    v_new := v_cur + (v_sign * r.qty)::integer;
    if v_new < 0 then
      raise exception 'Stok % tidak cukup untuk % - % (tersedia %, diminta %).',
        case when v_bucket = 'good' then 'bagus' else 'rusak' end,
        b.sku_code, b.name, v_cur, r.qty;
    end if;

    if v_bucket = 'good' then
      update public.stock_balances set qty_good = v_new, updated_at = now() where sku_id = r.sku_id;
    else
      update public.stock_balances set qty_damaged = v_new, updated_at = now() where sku_id = r.sku_id;
    end if;

    insert into public.stock_movements
      (transaction_id, sku_id, bucket, qty_change, balance_after, trx_date, trx_type)
    values
      (v_trx_id, r.sku_id, v_bucket, (v_sign * r.qty)::integer, v_new, v_today, p_type);
  end loop;

  return jsonb_build_object('id', v_trx_id, 'trx_no', v_trx_no, 'lines', v_lines,
                            'total_qty', v_total, 'duplicate', false);
end;
$$;


-- 6b. Pembatalan transaksi (admin / supervisor). Stok dikembalikan lewat
--     transaksi pembalik; gagal bila pembatalan membuat stok negatif.
create or replace function public.void_transaction(p_trx_id uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_name    text;
  v_today   date := public.today_wib();
  t         public.transactions%rowtype;
  v_new_id  uuid;
  v_new_no  text;
  r         record;
  b         record;
  v_cur     integer;
  v_new     integer;
begin
  perform public.assert_role(array['admin', 'supervisor']);

  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'Alasan pembatalan wajib diisi.';
  end if;

  select * into t from public.transactions where id = p_trx_id for update;
  if not found then raise exception 'Transaksi tidak ditemukan.'; end if;
  if t.voided_at is not null then raise exception 'Transaksi ini sudah dibatalkan sebelumnya.'; end if;
  if t.trx_type in ('opname', 'void') then
    raise exception 'Transaksi opname / pembatalan tidak dapat dibatalkan. Lakukan opname ulang bila perlu.';
  end if;

  select p.full_name into v_name from public.profiles p where p.id = v_uid;

  v_new_no := 'VD-' || to_char(v_today, 'YYMMDD') || '-' ||
              lpad(nextval('public.seq_trx_no')::text, 5, '0');

  insert into public.transactions
    (trx_no, trx_type, trx_date, reference_no, party, notes, total_qty, line_count,
     void_of, created_by, created_by_name)
  values
    (v_new_no, 'void', v_today, t.trx_no, t.party, trim(p_reason), t.total_qty, t.line_count,
     t.id, v_uid, v_name)
  returning id into v_new_id;

  for r in
    select m.sku_id, m.bucket, sum(m.qty_change)::integer as q
    from public.stock_movements m
    where m.transaction_id = t.id
    group by m.sku_id, m.bucket
    order by m.sku_id, m.bucket
  loop
    select s.sku_code, s.name into b from public.skus s where s.id = r.sku_id;

    if r.bucket = 'good' then
      select sb.qty_good into v_cur from public.stock_balances sb where sb.sku_id = r.sku_id for update;
    else
      select sb.qty_damaged into v_cur from public.stock_balances sb where sb.sku_id = r.sku_id for update;
    end if;

    v_new := v_cur - r.q;
    if v_new < 0 then
      raise exception 'Pembatalan gagal: stok % untuk % - % akan menjadi negatif (saat ini %, perlu dikurangi %).',
        case when r.bucket = 'good' then 'bagus' else 'rusak' end, b.sku_code, b.name, v_cur, r.q;
    end if;

    if r.bucket = 'good' then
      update public.stock_balances set qty_good = v_new, updated_at = now() where sku_id = r.sku_id;
    else
      update public.stock_balances set qty_damaged = v_new, updated_at = now() where sku_id = r.sku_id;
    end if;

    insert into public.stock_movements
      (transaction_id, sku_id, bucket, qty_change, balance_after, trx_date, trx_type)
    values (v_new_id, r.sku_id, r.bucket, -r.q, v_new, v_today, 'void');
  end loop;

  update public.transactions
  set voided_at = now(), voided_by = v_uid, voided_by_name = v_name, void_reason = trim(p_reason)
  where id = t.id;

  return jsonb_build_object('id', v_new_id, 'trx_no', v_new_no);
end;
$$;


-- ---------------------------------------------------------------------
-- 7. FUNGSI STOCK OPNAME
-- ---------------------------------------------------------------------

create or replace function public.opname_create(p_notes text default null)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_name text;
  v_id   uuid;
  v_no   text;
begin
  perform public.assert_role(array['admin', 'supervisor', 'staff']);
  select p.full_name into v_name from public.profiles p where p.id = v_uid;
  v_no := 'SO-' || to_char(public.today_wib(), 'YYMMDD') || '-' ||
          lpad(nextval('public.seq_opname_no')::text, 4, '0');
  insert into public.stock_opnames (opname_no, opname_date, notes, status, created_by, created_by_name)
  values (v_no, public.today_wib(), nullif(trim(p_notes), ''), 'draft', v_uid, v_name)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'opname_no', v_no);
end;
$$;

-- Simpan hasil hitung (satu atau banyak barang sekaligus).
-- p_rows contoh: [{"sku_id":"...","good":10,"damaged":0}, {"sku_code":"ABC1","good":5,"damaged":null}]
-- good/damaged = null berarti "tidak dihitung". Keduanya null = hapus dari daftar.
create or replace function public.opname_set_counts(p_opname_id uuid, p_rows jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_name    text;
  v_status  text;
  e         jsonb;
  v_sku     uuid;
  v_good    integer;
  v_dmg     integer;
  v_updated integer := 0;
  v_missing jsonb := '[]'::jsonb;
begin
  perform public.assert_role(array['admin', 'supervisor', 'staff']);

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Data hitungan tidak valid.';
  end if;

  -- kunci bersama: opname tidak bisa difinalisasi saat hitungan sedang disimpan
  select o.status into v_status from public.stock_opnames o where o.id = p_opname_id for share;
  if not found then raise exception 'Opname tidak ditemukan.'; end if;
  if v_status <> 'draft' then raise exception 'Opname ini sudah selesai / dibatalkan.'; end if;

  select p.full_name into v_name from public.profiles p where p.id = auth.uid();

  for e in select * from jsonb_array_elements(p_rows) loop
    v_sku := null;
    if nullif(e ->> 'sku_id', '') is not null then
      v_sku := (e ->> 'sku_id')::uuid;
      if not exists (select 1 from public.skus s where s.id = v_sku) then v_sku := null; end if;
    elsif nullif(e ->> 'sku_code', '') is not null then
      select s.id into v_sku from public.skus s where s.sku_code = upper(trim(e ->> 'sku_code'));
    end if;

    if v_sku is null then
      v_missing := v_missing || to_jsonb(coalesce(e ->> 'sku_code', e ->> 'sku_id', '?'));
      continue;
    end if;

    v_good := nullif(e ->> 'good', '')::integer;
    v_dmg  := nullif(e ->> 'damaged', '')::integer;
    if coalesce(v_good, 0) < 0 or coalesce(v_dmg, 0) < 0 then
      raise exception 'Jumlah hitungan tidak boleh negatif.';
    end if;

    if v_good is null and v_dmg is null then
      delete from public.stock_opname_items where opname_id = p_opname_id and sku_id = v_sku;
    else
      insert into public.stock_opname_items
        (opname_id, sku_id, counted_good, counted_damaged, counted_by_name, updated_at)
      values (p_opname_id, v_sku, v_good, v_dmg, v_name, now())
      on conflict (opname_id, sku_id) do update
        set counted_good = excluded.counted_good,
            counted_damaged = excluded.counted_damaged,
            counted_by_name = excluded.counted_by_name,
            updated_at = now();
    end if;
    v_updated := v_updated + 1;
  end loop;

  return jsonb_build_object('updated', v_updated, 'missing', v_missing);
end;
$$;

-- Finalisasi: stok sistem disesuaikan dengan hasil hitung (admin / supervisor)
create or replace function public.opname_finalize(p_opname_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_name    text;
  v_today   date := public.today_wib();
  o         public.stock_opnames%rowtype;
  it        record;
  v_trx_id  uuid;
  v_trx_no  text;
  v_g       integer;
  v_d       integer;
  v_ng      integer;
  v_nd      integer;
  v_total   bigint := 0;
  v_lines   integer := 0;
  v_items   integer;
begin
  perform public.assert_role(array['admin', 'supervisor']);

  select * into o from public.stock_opnames where id = p_opname_id for update;
  if not found then raise exception 'Opname tidak ditemukan.'; end if;
  if o.status <> 'draft' then raise exception 'Opname ini sudah selesai / dibatalkan.'; end if;

  select count(*) into v_items from public.stock_opname_items where opname_id = p_opname_id;
  if v_items = 0 then raise exception 'Belum ada barang yang dihitung.'; end if;

  select p.full_name into v_name from public.profiles p where p.id = v_uid;

  v_trx_no := 'ADJ-' || to_char(v_today, 'YYMMDD') || '-' ||
              lpad(nextval('public.seq_trx_no')::text, 5, '0');

  insert into public.transactions
    (trx_no, trx_type, trx_date, reference_no, notes, created_by, created_by_name)
  values
    (v_trx_no, 'opname', v_today, o.opname_no, o.notes, v_uid, v_name)
  returning id into v_trx_id;

  for it in
    select i.sku_id, i.counted_good, i.counted_damaged
    from public.stock_opname_items i
    where i.opname_id = p_opname_id
    order by i.sku_id
  loop
    insert into public.stock_balances (sku_id) values (it.sku_id) on conflict do nothing;

    select sb.qty_good, sb.qty_damaged into v_g, v_d
    from public.stock_balances sb where sb.sku_id = it.sku_id for update;

    v_ng := coalesce(it.counted_good, v_g);
    v_nd := coalesce(it.counted_damaged, v_d);

    if v_ng <> v_g then
      insert into public.stock_movements
        (transaction_id, sku_id, bucket, qty_change, balance_after, trx_date, trx_type)
      values (v_trx_id, it.sku_id, 'good', v_ng - v_g, v_ng, v_today, 'opname');
      v_total := v_total + abs(v_ng - v_g);
      v_lines := v_lines + 1;
    end if;
    if v_nd <> v_d then
      insert into public.stock_movements
        (transaction_id, sku_id, bucket, qty_change, balance_after, trx_date, trx_type)
      values (v_trx_id, it.sku_id, 'damaged', v_nd - v_d, v_nd, v_today, 'opname');
      v_total := v_total + abs(v_nd - v_d);
      v_lines := v_lines + 1;
    end if;

    update public.stock_balances
    set qty_good = v_ng, qty_damaged = v_nd, updated_at = now()
    where sku_id = it.sku_id;

    update public.stock_opname_items
    set system_good = v_g, system_damaged = v_d
    where opname_id = p_opname_id and sku_id = it.sku_id;
  end loop;

  update public.transactions set total_qty = v_total, line_count = v_lines where id = v_trx_id;

  update public.stock_opnames
  set status = 'final', finalized_by_name = v_name, finalized_at = now(), trx_id = v_trx_id
  where id = p_opname_id;

  return jsonb_build_object('trx_no', v_trx_no, 'items', v_items, 'adjusted_lines', v_lines);
end;
$$;

create or replace function public.opname_cancel(p_opname_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  perform public.assert_role(array['admin', 'supervisor']);
  select o.status into v_status from public.stock_opnames o where o.id = p_opname_id for update;
  if not found then raise exception 'Opname tidak ditemukan.'; end if;
  if v_status <> 'draft' then raise exception 'Hanya opname berstatus draft yang bisa dibatalkan.'; end if;
  update public.stock_opnames set status = 'cancelled' where id = p_opname_id;
end;
$$;


-- ---------------------------------------------------------------------
-- 8. FUNGSI MASTER SKU & PENGGUNA
-- ---------------------------------------------------------------------

-- Impor banyak SKU sekaligus (dari Excel / CSV). Kode SKU yang sudah ada diperbarui.
create or replace function public.import_skus(p_rows jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  e          jsonb;
  i          integer := 0;
  v_inserted integer := 0;
  v_updated  integer := 0;
  v_is_new   boolean;
  v_errors   jsonb := '[]'::jsonb;
begin
  perform public.assert_role(array['admin', 'supervisor']);

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Data impor tidak valid.';
  end if;

  for e in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      insert into public.skus
        (sku_code, barcode, barcode_carton, name, category, unit, units_per_carton, min_stock)
      values (
        e ->> 'sku_code',
        e ->> 'barcode',
        e ->> 'barcode_carton',
        e ->> 'name',
        e ->> 'category',
        e ->> 'unit',
        coalesce(nullif(e ->> 'units_per_carton', '')::integer, 1),
        coalesce(nullif(e ->> 'min_stock', '')::integer, 0)
      )
      on conflict (sku_code) do update set
        name             = excluded.name,
        barcode          = coalesce(excluded.barcode, public.skus.barcode),
        barcode_carton   = coalesce(excluded.barcode_carton, public.skus.barcode_carton),
        category         = coalesce(excluded.category, public.skus.category),
        unit             = coalesce(nullif(trim(coalesce(e ->> 'unit', '')), ''), public.skus.unit),
        units_per_carton = case when nullif(e ->> 'units_per_carton', '') is null
                                then public.skus.units_per_carton else excluded.units_per_carton end,
        min_stock        = case when nullif(e ->> 'min_stock', '') is null
                                then public.skus.min_stock else excluded.min_stock end
      returning (xmax = 0) into v_is_new;

      if v_is_new then v_inserted := v_inserted + 1; else v_updated := v_updated + 1; end if;
    exception when others then
      v_errors := v_errors || jsonb_build_object(
        'row', i, 'code', coalesce(e ->> 'sku_code', ''), 'error', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'errors', v_errors);
end;
$$;

-- Admin mengatur peran / mengaktifkan akun (tidak bisa mengubah akun sendiri)
create or replace function public.admin_set_user(p_user_id uuid, p_role text, p_active boolean)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_role(array['admin']);
  if p_user_id = auth.uid() then
    raise exception 'Anda tidak dapat mengubah peran atau status akun Anda sendiri.';
  end if;
  if p_role not in ('admin', 'supervisor', 'staff', 'viewer') then
    raise exception 'Peran tidak dikenal.';
  end if;
  update public.profiles set role = p_role, is_active = coalesce(p_active, false) where id = p_user_id;
  if not found then raise exception 'Pengguna tidak ditemukan.'; end if;
end;
$$;

-- Pengguna mengganti nama tampilannya sendiri
create or replace function public.set_my_name(p_name text)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'Silakan login terlebih dahulu.'; end if;
  if p_name is null or length(trim(p_name)) < 2 then raise exception 'Nama minimal 2 huruf.'; end if;
  update public.profiles set full_name = trim(p_name) where id = auth.uid();
end;
$$;


-- ---------------------------------------------------------------------
-- 9. TAMPILAN & LAPORAN
-- ---------------------------------------------------------------------

-- Daftar SKU + saldo stok (mengikuti aturan akses pemanggil)
create or replace view public.v_stock with (security_invoker = true) as
select s.id as sku_id, s.sku_code, s.barcode, s.barcode_carton, s.name, s.category,
       s.unit, s.units_per_carton, s.min_stock, s.is_active,
       coalesce(b.qty_good, 0)    as qty_good,
       coalesce(b.qty_damaged, 0) as qty_damaged,
       b.updated_at               as stock_updated_at
from public.skus s
left join public.stock_balances b on b.sku_id = s.id;

-- Ringkasan dashboard
create or replace function public.dashboard_summary()
returns jsonb
language plpgsql stable
set search_path = public, pg_temp
as $$
declare
  v_today date := public.today_wib();
  v_res   jsonb;
begin
  select jsonb_build_object(
    'sku_active',    count(*) filter (where s.is_active),
    'good_total',    coalesce(sum(b.qty_good), 0),
    'damaged_total', coalesce(sum(b.qty_damaged), 0),
    'low_count',     count(*) filter (where s.is_active and coalesce(b.qty_good, 0) > 0
                                       and coalesce(b.qty_good, 0) <= s.min_stock),
    'empty_count',   count(*) filter (where s.is_active and coalesce(b.qty_good, 0) = 0)
  ) into v_res
  from public.skus s
  left join public.stock_balances b on b.sku_id = s.id;

  v_res := v_res || (
    select jsonb_build_object(
      'today_in',  coalesce(sum(m.qty_change) filter (where m.trx_type = 'inbound'), 0),
      'today_out', coalesce(-sum(m.qty_change) filter (where m.trx_type = 'outbound'), 0),
      'today_return_good',    coalesce(sum(m.qty_change) filter (where m.trx_type = 'return_good'), 0),
      'today_return_damaged', coalesce(sum(m.qty_change) filter (where m.trx_type = 'return_damaged'), 0)
    )
    from public.stock_movements m where m.trx_date = v_today
  );

  v_res := v_res || jsonb_build_object(
    'today_trx', (select count(*) from public.transactions t where t.trx_date = v_today),
    'today', v_today
  );
  return v_res;
end;
$$;

-- Saldo awal suatu SKU sebelum tanggal tertentu (untuk kartu stok)
create or replace function public.sku_balance_before(p_sku_id uuid, p_date date)
returns table (good bigint, damaged bigint)
language sql stable
set search_path = public, pg_temp
as $$
  select coalesce(sum(m.qty_change) filter (where m.bucket = 'good'), 0)::bigint,
         coalesce(sum(m.qty_change) filter (where m.bucket = 'damaged'), 0)::bigint
  from public.stock_movements m
  where m.sku_id = p_sku_id and m.trx_date < p_date
$$;

-- Laporan per SKU untuk satu periode (harian: dari = sampai)
--   Bagus : awal + masuk - keluar + retur bagus + koreksi = akhir
--   Rusak : awal + retur rusak - dikeluarkan + koreksi   = akhir
-- "Koreksi" = penyesuaian opname + pembatalan transaksi
create or replace function public.report_stock_period(p_from date, p_to date)
returns table (
  sku_id uuid, sku_code text, name text, category text, unit text, units_per_carton integer,
  open_good bigint, in_qty bigint, out_qty bigint, ret_good bigint, adj_good bigint, close_good bigint,
  open_damaged bigint, ret_damaged bigint, dispose_qty bigint, adj_damaged bigint, close_damaged bigint
)
language sql stable
set search_path = public, pg_temp
as $$
  select s.id, s.sku_code, s.name, s.category, s.unit, s.units_per_carton,
    coalesce(sum(m.qty_change) filter (where m.bucket = 'good' and m.trx_date < p_from), 0)::bigint,
    coalesce(sum(m.qty_change) filter (where m.trx_type = 'inbound'
                 and m.trx_date between p_from and p_to), 0)::bigint,
    coalesce(-sum(m.qty_change) filter (where m.trx_type = 'outbound'
                 and m.trx_date between p_from and p_to), 0)::bigint,
    coalesce(sum(m.qty_change) filter (where m.trx_type = 'return_good'
                 and m.trx_date between p_from and p_to), 0)::bigint,
    coalesce(sum(m.qty_change) filter (where m.bucket = 'good' and m.trx_type in ('opname', 'void')
                 and m.trx_date between p_from and p_to), 0)::bigint,
    coalesce(sum(m.qty_change) filter (where m.bucket = 'good' and m.trx_date <= p_to), 0)::bigint,
    coalesce(sum(m.qty_change) filter (where m.bucket = 'damaged' and m.trx_date < p_from), 0)::bigint,
    coalesce(sum(m.qty_change) filter (where m.trx_type = 'return_damaged'
                 and m.trx_date between p_from and p_to), 0)::bigint,
    coalesce(-sum(m.qty_change) filter (where m.trx_type = 'dispose_damaged'
                 and m.trx_date between p_from and p_to), 0)::bigint,
    coalesce(sum(m.qty_change) filter (where m.bucket = 'damaged' and m.trx_type in ('opname', 'void')
                 and m.trx_date between p_from and p_to), 0)::bigint,
    coalesce(sum(m.qty_change) filter (where m.bucket = 'damaged' and m.trx_date <= p_to), 0)::bigint
  from public.skus s
  left join public.stock_movements m on m.sku_id = s.id and m.trx_date <= p_to
  group by s.id, s.sku_code, s.name, s.category, s.unit, s.units_per_carton
  order by s.sku_code
$$;


-- Rekap per hari untuk satu periode (grafik dashboard & laporan bulanan)
create or replace function public.report_daily(p_from date, p_to date)
returns table (
  day date, in_qty bigint, out_qty bigint, ret_good bigint, ret_damaged bigint,
  dispose_qty bigint, adj_net bigint, trx_count bigint
)
language plpgsql stable
set search_path = public, pg_temp
as $$
begin
  if p_to < p_from then raise exception 'Tanggal akhir lebih kecil dari tanggal awal.'; end if;
  if p_to - p_from > 400 then raise exception 'Periode terlalu panjang (maksimal 400 hari).'; end if;
  return query
  select d::date,
    coalesce(sum(m.qty_change) filter (where m.trx_type = 'inbound'), 0)::bigint,
    coalesce(-sum(m.qty_change) filter (where m.trx_type = 'outbound'), 0)::bigint,
    coalesce(sum(m.qty_change) filter (where m.trx_type = 'return_good'), 0)::bigint,
    coalesce(sum(m.qty_change) filter (where m.trx_type = 'return_damaged'), 0)::bigint,
    coalesce(-sum(m.qty_change) filter (where m.trx_type = 'dispose_damaged'), 0)::bigint,
    coalesce(sum(m.qty_change) filter (where m.trx_type in ('opname', 'void')), 0)::bigint,
    (select count(*) from public.transactions t
      where t.trx_date = d::date and t.trx_type not in ('opname', 'void') and t.voided_at is null)::bigint
  from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
  left join public.stock_movements m on m.trx_date = d::date
  group by d
  order by d;
end;
$$;


-- ---------------------------------------------------------------------
-- 10. KEAMANAN (Row Level Security + hak akses)
-- ---------------------------------------------------------------------
alter table public.profiles          enable row level security;
alter table public.skus              enable row level security;
alter table public.stock_balances    enable row level security;
alter table public.transactions      enable row level security;
alter table public.stock_movements   enable row level security;
alter table public.stock_opnames     enable row level security;
alter table public.stock_opname_items enable row level security;

-- Cabut semua hak langsung, lalu beri hanya yang diperlukan.
revoke all on public.profiles, public.skus, public.stock_balances, public.transactions,
              public.stock_movements, public.stock_opnames, public.stock_opname_items
  from anon, authenticated;
revoke all on public.v_stock from anon, authenticated;
revoke all on sequence public.seq_trx_no, public.seq_opname_no from anon, authenticated;

grant select on public.profiles, public.skus, public.stock_balances, public.transactions,
                public.stock_movements, public.stock_opnames, public.stock_opname_items,
                public.v_stock
  to authenticated;
grant insert, update on public.skus to authenticated;

-- Kebijakan baris: hanya akun AKTIF yang boleh membaca data gudang
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.current_user_role() is not null);

drop policy if exists skus_select on public.skus;
create policy skus_select on public.skus for select to authenticated
  using (public.current_user_role() is not null);

drop policy if exists skus_insert on public.skus;
create policy skus_insert on public.skus for insert to authenticated
  with check (public.current_user_role() in ('admin', 'supervisor'));

drop policy if exists skus_update on public.skus;
create policy skus_update on public.skus for update to authenticated
  using (public.current_user_role() in ('admin', 'supervisor'))
  with check (public.current_user_role() in ('admin', 'supervisor'));

drop policy if exists balances_select on public.stock_balances;
create policy balances_select on public.stock_balances for select to authenticated
  using (public.current_user_role() is not null);

drop policy if exists transactions_select on public.transactions;
create policy transactions_select on public.transactions for select to authenticated
  using (public.current_user_role() is not null);

drop policy if exists movements_select on public.stock_movements;
create policy movements_select on public.stock_movements for select to authenticated
  using (public.current_user_role() is not null);

drop policy if exists opnames_select on public.stock_opnames;
create policy opnames_select on public.stock_opnames for select to authenticated
  using (public.current_user_role() is not null);

drop policy if exists opname_items_select on public.stock_opname_items;
create policy opname_items_select on public.stock_opname_items for select to authenticated
  using (public.current_user_role() is not null);

-- Fungsi hanya boleh dipanggil pengguna yang sudah login
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('today_wib', 'current_user_role', 'assert_role', 'post_transaction',
                        'void_transaction', 'opname_create', 'opname_set_counts', 'opname_finalize',
                        'opname_cancel', 'import_skus', 'admin_set_user', 'set_my_name',
                        'dashboard_summary', 'sku_balance_before', 'report_stock_period',
                        'report_daily')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;

-- Minta Supabase memuat ulang daftar fungsi
notify pgrst, 'reload schema';
