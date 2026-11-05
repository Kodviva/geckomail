-- Yükseltme fikstürü: 1.0.7 (şema 18) tablolarında üretilmiş sahte veri. Sır yok: parolalar sahte bloblar, alan
-- adları .invalid, hesaplar enabled=0. scripts/schema-fixture.mjs dışında kullanılmaz.
INSERT INTO users (id, username, password_hash, role, enabled, created_at) VALUES
  (1, 'yonetici', 'sahte-ozet-1', 'admin', 1, 1760000000000),
  (2, 'uye', 'sahte-ozet-2', 'member', 1, 1760000000000);

INSERT INTO groups (id, name, color, created_at) VALUES (100, 'Muhasebe', '#8d7ba6', 1760000000000);
INSERT INTO user_group_permissions (user_id, group_id, can_view, can_manage) VALUES (2, 100, 1, 0);

-- 1: parola, 2: kasa (secure=1), 3: OAuth (password_enc yenileme belirteci yerine)
INSERT INTO accounts (id, email, display_name, imap_host, imap_port, smtp_host, smtp_port, password_enc, enabled, group_id, secure, password_changed_at, auth_type, created_at) VALUES
  (1, 'parola@fixture.invalid', 'Parola', 'imap.fixture.invalid', 993, 'smtp.fixture.invalid', 465, x'736168746501', 0, 100, 0, 1760000000000, 'password', 1760000000000),
  (2, 'kasa@fixture.invalid', 'Kasa', 'imap.fixture.invalid', 993, 'smtp.fixture.invalid', 465, x'736168746502', 0, NULL, 1, 1760000000000, 'password', 1760000000000),
  (3, 'oauth@fixture.invalid', 'OAuth', 'imap.fixture.invalid', 993, 'smtp.fixture.invalid', 465, x'736168746503', 0, NULL, 0, 1760000000000, 'oauth:google', 1760000000000);

INSERT INTO folders (id, account_id, path, kind, uidvalidity, last_seen_uidnext) VALUES
  (1, 1, 'INBOX', 'inbox', 1, 134),
  (2, 2, 'INBOX', 'inbox', 1, 134),
  (3, 3, 'INBOX', 'inbox', 1, 134);

-- 200 ileti: hesaplara eşit dağılır, her beşi aynı sohbette
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
INSERT INTO messages (id, folder_id, account_id, folder_kind, uid, message_id, subject, from_name, from_addr, to_json, date, size, seen, preview, thread_root)
SELECT i, (i % 3) + 1, (i % 3) + 1, 'inbox', i, '<' || i || '@fixture.invalid>', 'Fikstür ileti ' || i, 'Gönderen', 'gonderen@fixture.invalid',
       '[{"addr":"alici@fixture.invalid"}]', 1760000000000 + i * 60000, 1024, i % 2, 'Önizleme ' || i, 'sohbet-' || (i / 5)
FROM n;

INSERT INTO bodies (message_id, text_plain, html, fetched_at, last_access_at, raw_size, text_bytes)
SELECT id, 'Gövde metni ' || id, '<p>Gövde metni ' || id || '</p>', date, date, 1024, 16 FROM messages;

INSERT INTO messages_fts (rowid, subject, from_text, to_text, body_text)
SELECT id, subject, from_addr, 'alici@fixture.invalid', 'Gövde metni ' || id FROM messages;

INSERT INTO rules (id, name, enabled, account_id, conditions_json, actions_json, created_at) VALUES
  (1, 'Fatura kuralı', 0, 1, '{"all":[{"field":"subject","op":"contains","value":"fatura"}]}', '[{"type":"markRead"}]', 1760000000000);
INSERT INTO webhooks (id, name, url, secret, enabled, created_at) VALUES
  (1, 'Fikstür webhook', 'https://hook.fixture.invalid/gelen', NULL, 0, 1760000000000);
INSERT INTO templates (id, name, subject, body, updated_at) VALUES (1, 'Teşekkür', 'Teşekkürler', 'Teşekkür ederiz.', 1760000000000);
INSERT INTO followups (id, account_id, message_id, subject, to_text, created_at, due_at) VALUES
  (1, 1, '<takip@fixture.invalid>', 'Takip', 'alici@fixture.invalid', 1760000000000, 4070908800000);
-- bekleyen işlem: hesap kapalı ve alan adı çözülmez, hiçbir yere gitmez
INSERT INTO op_queue (id, account_id, kind, payload_json, state, created_at) VALUES
  (1, 1, 'store_flags', '{"folderPath":"INBOX","uids":[3],"seen":true}', 'pending', 1760000000000);

INSERT INTO prefs (key, value) VALUES
  ('login_bio_flag', '1'),
  ('login_bio_user', 'yonetici'),
  ('login_bio_blob', 'c2FodGU='),
  ('notifyQuiet', '0'),
  ('autoBackup', '0');
