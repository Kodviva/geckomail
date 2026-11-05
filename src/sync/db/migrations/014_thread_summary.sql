-- Konuşma özeti (R26): konuşma görünümü her tazelemede klasördeki tüm mesajları thread_root'a göre
-- grupluyordu (150k mesajda ≈220 ms, R25 ile her olayda). Özet satırı (klasör, konuşma) başına
-- tetikleyicilerle güncel tutulur; yalnız görünür mesajlar (hidden=0, snooze_until=0) sayılır.
CREATE TABLE thread_summary (
  folder_id INTEGER NOT NULL,
  thread_root TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  folder_kind TEXT NOT NULL,
  latest_id INTEGER NOT NULL,
  latest_date INTEGER NOT NULL,
  cnt INTEGER NOT NULL,
  unread INTEGER NOT NULL,
  PRIMARY KEY (folder_id, thread_root)
) WITHOUT ROWID;
CREATE INDEX thread_summary_kind ON thread_summary (folder_kind, latest_date DESC);
CREATE INDEX thread_summary_account ON thread_summary (account_id, folder_kind, latest_date DESC);
CREATE INDEX thread_summary_folder ON thread_summary (folder_id, latest_date DESC);
CREATE INDEX thread_summary_root ON thread_summary (thread_root);
CREATE INDEX IF NOT EXISTS idx_msgs_folder_thread ON messages (folder_id, thread_root);

INSERT INTO thread_summary (folder_id, thread_root, account_id, folder_kind, latest_id, latest_date, cnt, unread)
  SELECT folder_id, thread_root, account_id, folder_kind, id, MAX(date), COUNT(*), SUM(seen = 0)
  FROM messages WHERE hidden = 0 AND snooze_until = 0 AND thread_root IS NOT NULL
  GROUP BY folder_id, thread_root;

-- (klasör, konuşma) çiftini yeniden hesaplayan gövde tetikleyicilerde tekrarlanır (SQLite'ta prosedür yok).
CREATE TRIGGER thread_summary_ins AFTER INSERT ON messages WHEN NEW.thread_root IS NOT NULL
BEGIN
  DELETE FROM thread_summary WHERE folder_id = NEW.folder_id AND thread_root = NEW.thread_root;
  INSERT INTO thread_summary (folder_id, thread_root, account_id, folder_kind, latest_id, latest_date, cnt, unread)
    SELECT folder_id, thread_root, account_id, folder_kind, id, MAX(date), COUNT(*), SUM(seen = 0)
    FROM messages WHERE folder_id = NEW.folder_id AND thread_root = NEW.thread_root AND hidden = 0 AND snooze_until = 0
    GROUP BY folder_id, thread_root;
END;

CREATE TRIGGER thread_summary_del AFTER DELETE ON messages WHEN OLD.thread_root IS NOT NULL
BEGIN
  DELETE FROM thread_summary WHERE folder_id = OLD.folder_id AND thread_root = OLD.thread_root;
  INSERT INTO thread_summary (folder_id, thread_root, account_id, folder_kind, latest_id, latest_date, cnt, unread)
    SELECT folder_id, thread_root, account_id, folder_kind, id, MAX(date), COUNT(*), SUM(seen = 0)
    FROM messages WHERE folder_id = OLD.folder_id AND thread_root = OLD.thread_root AND hidden = 0 AND snooze_until = 0
    GROUP BY folder_id, thread_root;
END;

CREATE TRIGGER thread_summary_upd AFTER UPDATE OF seen, hidden, snooze_until, date, thread_root, folder_id, folder_kind, account_id ON messages
WHEN OLD.seen IS NOT NEW.seen OR OLD.hidden IS NOT NEW.hidden OR OLD.snooze_until IS NOT NEW.snooze_until
  OR OLD.date IS NOT NEW.date OR OLD.thread_root IS NOT NEW.thread_root OR OLD.folder_id IS NOT NEW.folder_id
  OR OLD.folder_kind IS NOT NEW.folder_kind OR OLD.account_id IS NOT NEW.account_id
BEGIN
  DELETE FROM thread_summary WHERE folder_id = OLD.folder_id AND thread_root = OLD.thread_root;
  INSERT INTO thread_summary (folder_id, thread_root, account_id, folder_kind, latest_id, latest_date, cnt, unread)
    SELECT folder_id, thread_root, account_id, folder_kind, id, MAX(date), COUNT(*), SUM(seen = 0)
    FROM messages WHERE folder_id = OLD.folder_id AND thread_root = OLD.thread_root AND hidden = 0 AND snooze_until = 0
    GROUP BY folder_id, thread_root;
  DELETE FROM thread_summary WHERE folder_id = NEW.folder_id AND thread_root = NEW.thread_root;
  INSERT INTO thread_summary (folder_id, thread_root, account_id, folder_kind, latest_id, latest_date, cnt, unread)
    SELECT folder_id, thread_root, account_id, folder_kind, id, MAX(date), COUNT(*), SUM(seen = 0)
    FROM messages WHERE folder_id = NEW.folder_id AND thread_root = NEW.thread_root AND hidden = 0 AND snooze_until = 0
    GROUP BY folder_id, thread_root;
END;
