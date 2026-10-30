-- Open banking (Enable Banking): sesiones, cuentas enlazadas y id externo para no duplicar
alter table pagos add column if not exists ext_id text unique;

create table if not exists banco_sesiones (
  id text primary key,
  banco text not null,
  valido_hasta timestamptz,
  creado timestamptz default now(),
  ultimo_sync timestamptz,
  error text
);

create table if not exists banco_cuentas (
  uid text primary key,
  sesion text references banco_sesiones(id) on delete cascade,
  banco text,
  nombre text,
  iban text,
  tipo text,
  cuenta_app text,
  saldo numeric,
  saldo_fecha timestamptz,
  desde date
);

alter table banco_sesiones enable row level security;
alter table banco_cuentas enable row level security;
drop policy if exists solo_danny on banco_sesiones;
drop policy if exists solo_danny on banco_cuentas;
create policy solo_danny on banco_sesiones for select using (es_danny());
create policy solo_danny on banco_cuentas for all using (es_danny()) with check (es_danny());
