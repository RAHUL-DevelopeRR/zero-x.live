BEGIN;

-- Reverts 20261026000000_push_devices.sql: drops the device-keyed push functions, the index and
-- the device_id column. Rows registered through /api/push/devices stay as plain token rows.
-- Safe to re-run.

DROP FUNCTION IF EXISTS public.zerox_push_device_register(uuid, text, text, text, boolean, boolean);
DROP FUNCTION IF EXISTS public.zerox_push_device_list(uuid);
DROP FUNCTION IF EXISTS public.zerox_push_device_targets(uuid, text[]);
DROP FUNCTION IF EXISTS public.zerox_push_device_delete(uuid, text);
DROP INDEX IF EXISTS public.zerox_push_tokens_device_idx;
ALTER TABLE public.zerox_push_tokens DROP COLUMN IF EXISTS device_id;

NOTIFY pgrst, 'reload schema';

COMMIT;
