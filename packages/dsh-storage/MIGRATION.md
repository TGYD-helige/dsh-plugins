# `user_id` → `create_by` rollout

Apply this to **both** `ai_messages` and `ai_chat_histories` before enabling the new mirror. Back up the tables first. Use the same column width as the source request identity; the shipped MySQL/PostgreSQL/SQL Server schemas use `VARCHAR(100)`.

1. **Expand while old writers still run.** Add nullable `create_by`, then backfill it from `user_id` where null. Keep `user_id` and its old indexes. Make a missing `user_id` on new inserts legal by giving it a database default of `'0'` (the legacy local-user sentinel). Old writers continue supplying `user_id`; new writers supply `create_by`. Repeat the backfill while versions overlap.
2. **Deploy this plugin.** Pass the authenticated platform user ID from the A2A request (`x-platform-user-id`, then `x-app-user-id`) before the first turn. Keep requests for an existing context on one version during overlap: old readers filter by `user_id` and cannot correctly attribute rows whose new writer used the compatibility default. Watch `[dsh-storage] database error:` logs and verify new message and history rows have the expected `create_by`.
3. **Contract after all old writers/readers are gone.** Run the backfill once more, check `SELECT COUNT(*) ... WHERE create_by IS NULL` returns zero on each table, then make `create_by` non-null. Drop `user_id`, its default and its indexes only after no old process uses them. The shipped Prisma schemas describe this final shape; do not run `db push` against the old schema as a shortcut.

Provider DDL for the expand phase (run each statement for both tables):

| Provider | Add `create_by` | Permit new inserts without `user_id` |
| --- | --- | --- |
| MySQL | `ALTER TABLE ai_messages ADD COLUMN create_by VARCHAR(100) NULL;` | `ALTER TABLE ai_messages MODIFY COLUMN user_id CHAR(36) NOT NULL DEFAULT '0';` |
| PostgreSQL | `ALTER TABLE ai_messages ADD COLUMN create_by VARCHAR(100);` | `ALTER TABLE ai_messages ALTER COLUMN user_id SET DEFAULT '0';` |
| SQL Server | `ALTER TABLE ai_messages ADD create_by VARCHAR(100) NULL;` | `ALTER TABLE ai_messages ADD CONSTRAINT DF_ai_messages_user_id DEFAULT ('0') FOR user_id;` |
| SQLite | `ALTER TABLE ai_messages ADD COLUMN create_by TEXT;` | Rebuild the table with `user_id TEXT NOT NULL DEFAULT '0'`, copying all rows and recreating its indexes, triggers, and foreign keys. SQLite cannot change an existing column default in place. |

For `ai_chat_histories`, replace the table name (and the SQL Server constraint name) in the examples. Backfill with `UPDATE ai_messages SET create_by = user_id WHERE create_by IS NULL;` and the analogous history statement. During the final phase use each provider's `ALTER COLUMN`/table-rebuild operation to make `create_by` required and remove `user_id`.
