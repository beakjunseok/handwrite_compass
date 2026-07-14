alter table notes add column if not exists user_id uuid references auth.users (id) on delete cascade;
alter table notes add column if not exists note_type text not null default 'text' check (note_type in ('text', 'canvas'));
alter table notes add column if not exists pages jsonb;

alter table quizzes add column if not exists user_id uuid references auth.users (id) on delete cascade;

drop policy if exists "anon full access" on notes;
drop policy if exists "anon full access" on quizzes;

create policy "users manage own notes" on notes
    for all
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

create policy "users manage own quizzes" on quizzes
    for all
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
