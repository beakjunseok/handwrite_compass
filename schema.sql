create table if not exists notes (
    id uuid primary key default gen_random_uuid(),
    title text not null default '제목 없음',
    content text not null,
    keywords text[] not null default '{}',
    summary text not null default '',
    created_at timestamptz not null default now()
);

create index if not exists notes_keywords_idx on notes using gin (keywords);

create table if not exists quizzes (
    id uuid primary key default gen_random_uuid(),
    note_id uuid not null references notes (id) on delete cascade,
    questions jsonb not null default '[]',
    created_at timestamptz not null default now()
);

create index if not exists quizzes_note_id_idx on quizzes (note_id);
