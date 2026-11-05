-- Yükseltme fikstürü: seed-18 üstüne 019–024 tablolarındaki sahte veri (Parça 1–3 sırasında açılmış kurulum).
INSERT INTO user_prefs (user_id, key, value) VALUES (1, 'notifyQuiet', '0');
INSERT INTO user_signatures (user_id, account_id, signature) VALUES (2, 1, 'Üye imzası');
INSERT INTO templates (id, owner_user_id, name, subject, body, updated_at) VALUES (2, 2, 'Kişisel', NULL, 'Kişisel şablon', 1760000000000);
INSERT INTO web_sessions (id_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent) VALUES
  ('sahte-oturum-ozeti', 1, 1760000000000, 1760000000000, 1760000000001, '192.0.2.1', 'fikstur');
INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES
  ('sahte-anahtar', 1, x'00', 0, NULL, 'Fikstür anahtarı', 1760000000000);
INSERT INTO send_ids (id, user_id, created_at, content_hash, op_id) VALUES ('sahte-gonderim', 1, 1760000000000, 'sahte', NULL);
INSERT INTO notify_rules (id, user_id, name, enabled, position, groups_json, level, created_at) VALUES
  (1, 1, 'Önemli', 0, 0, '[]', 'urgent', 1760000000000);
INSERT INTO notify_account_prefs (user_id, account_id, mode) VALUES (1, 1, 'on');
UPDATE followups SET user_id = 1 WHERE id = 1;
