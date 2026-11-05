#!/usr/bin/sh
# Pigeonhole'un yanıt postası `sendmail -f <gönderen> -- <alıcı>` ile gelir: yerelde teslim edilir
from=
while [ $# -gt 0 ]; do
  case "$1" in
    -f) from=$2; shift 2 ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
exec /dovecot/libexec/dovecot/dovecot-lda -d "$1" -f "$from"
