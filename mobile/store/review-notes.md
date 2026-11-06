# Mağaza inceleme notu

Metin inceleme formuna yapıştırılır. Demo kimlikleri bu dosyaya değil, yalnız forma yazılır.

GeckoMail is a client for a self-hosted mail engine. It needs a server address at first launch, so a demo server is provided for review.

- Server: https://demo.kodviva.com
- Username and password: entered in the store form
- All demo data is fictional (`example.test`). No real mail leaves the demo server.

What to try: sign in, open a message, open an attachment, enable app lock under Settings, share a photo from Photos to GeckoMail and open the app (the share extension asks you to open GeckoMail; the attachment appears in the composer).

Notifications need a real device registered through our relay. The relay only sees an encrypted box. Reviewers can enable them under Settings.

Passkeys, account linking, backups and administration open in the system browser on the user's own server, because their credentials are bound to that server's origin.

The app has no in-app account creation or deletion: accounts are provisioned and deleted by the organization admin.

The app uses no tracking, advertising or analytics.
