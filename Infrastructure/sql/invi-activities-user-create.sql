-- Run ONLY after the read-only preflight and invi-activities-user-provider-system.sql
-- report provider_system_enabled = 1. This script refuses to create a user until
-- the dedicated System Provider enum value exists.
-- This file intentionally leaves the transaction OPEN. Inspect the final row and
-- COMMIT manually only when exactly one clean identity is shown; otherwise ROLLBACK.
-- Re-running after COMMIT is idempotent: an existing name prevents another insert.
START TRANSACTION;

INSERT INTO UserTable (
  DisplayName, ExternalId, AvatarImageKey, Email, PhoneNumber, Password,
  RegisteredIp, CreatedOn, LastIp, LastActive,
  isActive, isSuspended, isAdmin, isVerified,
  DeviceHostname, DeviceSerialId, ExpoPushToken, Provider, DeletedAt
)
SELECT
  'Invi Activities', NULL, '', NULL, NULL, NULL,
  '', UTC_TIMESTAMP(), '', UTC_TIMESTAMP(),
  1, 0, 0, 0,
  '', '', '', 'System', NULL
WHERE NOT EXISTS (SELECT 1 FROM UserTable WHERE DisplayName = 'Invi Activities')
  AND EXISTS (
    SELECT 1
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'UserTable'
      AND COLUMN_NAME = 'Provider'
      AND COLUMN_TYPE LIKE '%''System''%'
  );

SELECT ROW_COUNT() AS inserted_rows;
SELECT UserId, DisplayName, Provider,
       (Password IS NOT NULL) AS has_password,
       (Email IS NOT NULL) AS has_email,
       (PhoneNumber IS NOT NULL) AS has_phone,
       (ExternalId IS NOT NULL) AS has_external_id,
       isActive, isSuspended, isAdmin, isVerified,
       (DeletedAt IS NOT NULL) AS is_deleted
FROM UserTable
WHERE DisplayName = 'Invi Activities'
ORDER BY UserId;

-- A valid result has identity_count=1 and verified_user_id equal to the row above.
-- Zero or NULL is a STOP. Never copy a guessed or unrelated UserId into Bicep.
SELECT COUNT(*) AS identity_count,
       CASE WHEN COUNT(*) = 1
             AND SUM(Provider = 'System' AND Password IS NULL AND Email IS NULL
                     AND PhoneNumber IS NULL AND ExternalId IS NULL
                     AND isActive = 1 AND isSuspended = 0 AND isAdmin = 0
                     AND isVerified = 0 AND DeletedAt IS NULL) = 1
            THEN MIN(UserId) ELSE NULL END AS verified_user_id
FROM UserTable
WHERE DisplayName = 'Invi Activities';
