## Summary

<!-- What does this PR change, and why? Link the issue if one exists. -->

## Area

- [ ] Quota / rate limiting
- [ ] Transport guard / streaming / retries
- [ ] CPA management proxy
- [ ] Accounting / SQLite / outbox
- [ ] Dashboard (Aozora UI)
- [ ] Provider quota integration
- [ ] Tests
- [ ] Documentation

## Verification

<!-- Be explicit about what you actually ran. Do not claim a check you did not run. -->

- [ ] `npm test` passes locally
- [ ] If UI files changed, the dashboard was opened in a browser
- [ ] If the schema changed, migration behavior was checked against an existing database
- [ ] If a version was bumped, `package.json`, the dashboard badge, and asset cache-busting strings match

```text
Paste the relevant test output or reproduction command here.
```

## Checklist

- [ ] I removed all secrets, API keys, cookies, and real account identifiers from this diff.
- [ ] `CHANGELOG.md` has an entry if this changes behavior or fixes a user-visible bug.
- [ ] Documentation (`README.md`, `docs/`, `llms.txt`, `llms-full.txt`) is updated where the change makes it stale.
- [ ] If this touches a module owned by an upstream project, I checked upstream releases or issues first.
