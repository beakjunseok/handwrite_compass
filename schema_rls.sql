alter table notes enable row level security;
alter table quizzes enable row level security;

create policy "anon full access" on notes
    for all
    using (true)
    with check (true);

create policy "anon full access" on quizzes
    for all
    using (true)
    with check (true);
