-- v1.0: soft-delete (Geri Al), imzalar, konuşma zinciri kolonları
ALTER TABLE messages ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN in_reply_to TEXT;
ALTER TABLE messages ADD COLUMN thread_root TEXT;
ALTER TABLE accounts ADD COLUMN signature TEXT;
CREATE INDEX idx_msgs_thread ON messages (thread_root) WHERE thread_root IS NOT NULL;
-- mevcut satırlar: zincir bilgisi yok, kendi kimliği kök olur
UPDATE messages SET thread_root = COALESCE(message_id, 'local-' || id);
