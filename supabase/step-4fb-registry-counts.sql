-- Read-only: registry counts.
SELECT (SELECT count(*) FROM public.practices)::text AS practices,
       (SELECT count(*) FROM public.practice_memberships)::text AS practice_memberships,
       (SELECT count(*) FROM public.client_entities)::text AS client_entities,
       (SELECT count(*) FROM public.ledger_books)::text AS ledger_books,
       (SELECT count(*) FROM public.default_tenant_identities)::text AS default_tenant_identities;
