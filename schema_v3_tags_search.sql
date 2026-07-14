create extension if not exists pg_trgm;

alter table notes add column if not exists tags text[] not null default '{}';
alter table notes add column if not exists is_favorite boolean not null default false;

create index if not exists notes_tags_idx on notes using gin (tags);
create index if not exists notes_content_trgm_idx on notes using gin (content gin_trgm_ops);
create index if not exists notes_title_trgm_idx on notes using gin (title gin_trgm_ops);
