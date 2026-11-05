-- Faz D: List-Unsubscribe / List-Unsubscribe-Post header yakalama (RFC 8058 tek-tık abonelik iptali)
ALTER TABLE messages ADD COLUMN list_unsubscribe TEXT;
ALTER TABLE messages ADD COLUMN list_unsubscribe_post TEXT;
