-- Takip hatırlatıcısı (R30): "yanıt gelmezse hatırlat". Gönderimde Message-ID sabitlendiği için kayıt
-- kuyruğa alınırken açılır; yanıt (In-Reply-To ya da aynı konuşma) gelirse kendiliğinden kapanır.
CREATE TABLE followups (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  op_id INTEGER,
  message_id TEXT NOT NULL,
  subject TEXT,
  to_text TEXT,
  created_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'waiting', -- waiting | due | replied | dismissed
  notified_at INTEGER,
  closed_at INTEGER
);
CREATE INDEX followups_open ON followups (state, due_at);
CREATE INDEX IF NOT EXISTS idx_msgs_in_reply_to ON messages (in_reply_to) WHERE in_reply_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_msgs_message_id ON messages (account_id, message_id) WHERE message_id IS NOT NULL;
