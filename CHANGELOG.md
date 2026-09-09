# Defense Request completion feedback fix

- When a defense schedule is `Completed`, the linked defense request is now forced to `Completed`.
- Its feedback is also forced to `Defense completed.` so old values such as `Approved for scheduling.` cannot remain after completion.
- The synchronization remains idempotent and runs when defense requests/dashboard data are loaded.
