#!/usr/bin/env bash
# S/MIME test fikstürleri. Buradaki anahtarların hepsi test anahtarıdır, üretimle ilgisi yoktur.
# OpenSSL 3.4+ gerekir (-not_before/-not_after); eski biçimli .p12 ve RC2 için legacy sağlayıcı şarttır.
# Kullanım: bash gen.sh (mevcut fikstürlerin üstüne yazar; testler yalnız üretilen dosyaları okur)
set -euo pipefail
cd "$(dirname "$0")"

find . -maxdepth 1 -type f ! -name gen.sh -delete
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

FROM=20190101000000Z
UNTIL=21000101000000Z
P12_PASS=test-fixture-only

cat > "$tmp/ext.cnf" <<'CNF'
[root]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash

[int]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
extendedKeyUsage = emailProtection

[int_pathlen0]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
extendedKeyUsage = emailProtection

[int_tls]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
extendedKeyUsage = serverAuth

[leaf_base]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,nonRepudiation,keyEncipherment
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
extendedKeyUsage = emailProtection

[alice]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,nonRepudiation,keyEncipherment
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
extendedKeyUsage = emailProtection
subjectAltName = email:alice@example.test
crlDistributionPoints = URI:http://crl.example.test/int.crl,URI:ldap://crl.example.test/cn=int

[nc_int]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
extendedKeyUsage = emailProtection
nameConstraints = critical,permitted;email:example.test

[nc_widen]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
extendedKeyUsage = emailProtection
nameConstraints = critical,permitted;email:victim.test

[nc_excl]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
extendedKeyUsage = emailProtection
nameConstraints = critical,excluded;email:victim.test

[nc_bad]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
extendedKeyUsage = emailProtection
2.5.29.30 = DER:30:15:A0:13:30:11:81:0C:65:78:61:6D:70:6C:65:2E:74:65:73:74:80:01:01

[leaf_ok_example]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = emailProtection
subjectAltName = email:ok@example.test

[leaf_victim]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = emailProtection
subjectAltName = email:ceo@victim.test

[leaf_anyof]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = emailProtection
subjectAltName = email:ok@example.test,email:ceo@victim.test

[leaf_dns]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = emailProtection
subjectAltName = DNS:example.test

[leaf_nosan]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = emailProtection

[leaf_ski]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = emailProtection
subjectAltName = email:alice@example.test
subjectKeyIdentifier = 00112233445566778899AABBCCDDEEFF00112233

[leaf_reasons]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = emailProtection
subjectAltName = email:alice@example.test
crlDistributionPoints = cdp_reasons

[cdp_reasons]
fullname = URI:http://crl.example.test/int.crl
reasons = keyCompromise

[bob]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,nonRepudiation,keyEncipherment
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
extendedKeyUsage = emailProtection
subjectAltName = email:bob@example.test

[revoked]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,nonRepudiation,keyEncipherment
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
extendedKeyUsage = emailProtection
subjectAltName = email:revoked@example.test
crlDistributionPoints = URI:http://crl.example.test/int.crl

[ldap_only]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,nonRepudiation,keyEncipherment
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
extendedKeyUsage = emailProtection
subjectAltName = email:ldap@example.test
crlDistributionPoints = URI:ldap://crl.example.test/cn=int

[sign_only]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
extendedKeyUsage = emailProtection
subjectAltName = email:alice@example.test

[server_eku]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
extendedKeyUsage = serverAuth
subjectAltName = email:alice@example.test

[no_eku]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
subjectAltName = email:alice@example.test

[no_san]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
extendedKeyUsage = emailProtection

[san_wins]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
extendedKeyUsage = emailProtection
subjectAltName = email:san@example.test

[critical_ext]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
extendedKeyUsage = emailProtection
subjectAltName = email:alice@example.test
1.3.6.1.4.1.99999.1 = critical,DER:0500

[self]
basicConstraints = critical,CA:TRUE
keyUsage = critical,digitalSignature,nonRepudiation,keyEncipherment,keyCertSign
subjectKeyIdentifier = hash
extendedKeyUsage = emailProtection
subjectAltName = email:alice@example.test
CNF

key() { openssl genrsa -out "$1.key" "${2:-2048}" 2>/dev/null; }

# issue <ad> <yayımcı> <uzantı> <konu>; ortam: MD (özet), NB/NA (geçerlilik), PSS=1 (RSA-PSS imza)
issue() {
  local name=$1 ca=$2 ext=$3 subj=$4
  [ -f "$name.key" ] || key "$name"
  openssl req -new -key "$name.key" -subj "$subj" -out "$tmp/$name.csr"
  openssl x509 -req -in "$tmp/$name.csr" -CA "$ca.crt" -CAkey "$ca.key" -CAcreateserial -CAserial "$tmp/serial" \
    "-${MD:-sha256}" -not_before "${NB:-$FROM}" -not_after "${NA:-$UNTIL}" -extfile "$tmp/ext.cnf" -extensions "$ext" -out "$name.crt" \
    ${PSS:+-sigopt rsa_padding_mode:pss -sigopt rsa_pss_saltlen:digest -sigopt rsa_mgf1_md:sha256}
}

# Kök ve ara
key root
openssl req -new -x509 -key root.key -subj '/O=GeckoMail Test/CN=Test Root' -sha256 \
  -not_before "$FROM" -not_after "$UNTIL" -extensions root -config <(printf '[req]\ndistinguished_name=d\n[d]\n'; cat "$tmp/ext.cnf") -out root.crt
issue int root int '/O=GeckoMail Test/CN=Test Intermediate'
issue int-tls root int_tls '/O=GeckoMail Test/CN=Test TLS Intermediate'
MD=sha1 issue int-sha1 root int '/O=GeckoMail Test/CN=Test SHA1 Intermediate'

# Yapraklar
issue alice int alice '/O=GeckoMail Test/CN=Alice'
issue bob int bob '/O=GeckoMail Test/CN=Bob'
issue mismatch int bob '/O=GeckoMail Test/CN=Mismatch'
issue revoked int revoked '/O=GeckoMail Test/CN=Revoked'
issue ldap-only int ldap_only '/O=GeckoMail Test/CN=Ldap Only'
issue sign-only int sign_only '/O=GeckoMail Test/CN=Sign Only'
issue server-eku int server_eku '/O=GeckoMail Test/CN=Server EKU'
issue no-eku int no_eku '/O=GeckoMail Test/CN=No EKU'
issue critical-ext int critical_ext '/O=GeckoMail Test/CN=Critical Ext'
issue san-wins int san_wins '/O=GeckoMail Test/CN=San Wins/emailAddress=subject@example.test'
issue subject-email int no_san '/O=GeckoMail Test/CN=Subject Email/emailAddress=subject@example.test'
NB=20200101000000Z NA=20210101000000Z issue expired int alice '/O=GeckoMail Test/CN=Expired'
MD=sha1 issue sha1 int alice '/O=GeckoMail Test/CN=SHA1 Leaf'
PSS=1 issue pss int alice '/O=GeckoMail Test/CN=PSS Leaf'
key rsa1024 1024
issue rsa1024 int alice '/O=GeckoMail Test/CN=RSA 1024'
issue under-tls int-tls alice '/O=GeckoMail Test/CN=Under TLS Intermediate'
issue under-sha1 int-sha1 alice '/O=GeckoMail Test/CN=Under SHA1 Intermediate'


# EC P-256
openssl ecparam -name prime256v1 -genkey -noout -out ec-p256-sec1.key
openssl pkcs8 -topk8 -nocrypt -in ec-p256-sec1.key -out ec-p256.key
rm ec-p256-sec1.key
issue ec-p256 int alice '/O=GeckoMail Test/CN=EC P-256'
openssl ecparam -name secp384r1 -genkey -noout -out ec-p384-sec1.key
openssl pkcs8 -topk8 -nocrypt -in ec-p384-sec1.key -out ec-p384.key
rm ec-p384-sec1.key
issue ec-p384 int alice '/O=GeckoMail Test/CN=EC P-384'

# Kendinden imzalı
key self-signed
openssl req -new -x509 -key self-signed.key -subj '/O=GeckoMail Test/CN=Self Signed' -sha256 \
  -not_before "$FROM" -not_after "$UNTIL" -extensions self -config <(printf '[req]\ndistinguished_name=d\n[d]\n'; cat "$tmp/ext.cnf") -out self-signed.crt

# Yaprağın imzaladığı sahte alt sertifika (basicConstraints atlatma denemesi)
issue fake-child alice alice '/O=GeckoMail Test/CN=Fake Child'

# 9 ara sertifikalı uzun yol
prev=root
: > deep-chain.pem
for i in 1 2 3 4 5 6 7 8 9; do
  issue "deep-$i" "$prev" int "/O=GeckoMail Test/CN=Deep $i"
  cat "deep-$i.crt" >> deep-chain.pem
  prev="deep-$i"
done
issue deep-leaf deep-9 alice '/O=GeckoMail Test/CN=Deep Leaf'
for i in 1 2 3 4 5 6 7 8 9; do rm "deep-$i.crt" "deep-$i.key"; done

# pathlen:0 ara sertifikanın altında yasak bir ara sertifika
issue pathlen-int root int_pathlen0 '/O=GeckoMail Test/CN=Pathlen Int'
issue pathlen-sub pathlen-int int '/O=GeckoMail Test/CN=Pathlen Sub'
issue pathlen-leaf pathlen-sub alice '/O=GeckoMail Test/CN=Pathlen Leaf'

# Birbirini imzalayan iki CA: düğüm oluşturan zincir kurucuyu sonsuza dek döndürmemeli
key cycle-a
key cycle-b
openssl req -new -key cycle-a.key -subj '/O=GeckoMail Test/CN=Cycle A' -out "$tmp/cycle-a.csr"
openssl req -new -key cycle-b.key -subj '/O=GeckoMail Test/CN=Cycle B' -out "$tmp/cycle-b.csr"
printf '[c]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n' > "$tmp/cycle.cnf"
openssl req -new -x509 -key cycle-a.key -subj '/O=GeckoMail Test/CN=Cycle A' -days 1 -out "$tmp/issuer-a.crt"
openssl req -new -x509 -key cycle-b.key -subj '/O=GeckoMail Test/CN=Cycle B' -days 1 -out "$tmp/issuer-b.crt"
cross() {
  openssl x509 -req -in "$tmp/cycle-$1.csr" -CA "$tmp/issuer-$2.crt" -CAkey "cycle-$2.key" -CAcreateserial -CAserial "$tmp/serial" -sha256 \
    -not_before "$FROM" -not_after "$UNTIL" -extfile "$tmp/cycle.cnf" -extensions c -out "cycle-$1.crt" 2>/dev/null
}
cross a b
cross b a
rm cycle-a.key cycle-b.key

# CRL: revoked.crt iptal edilir; aynı konu adıyla başka anahtarın imzaladığı liste sahtedir
crl() {
  local out=$1 cert=$2 k=$3
  shift 3
  : > "$tmp/index.txt"
  echo 01 > "$tmp/crlnumber"
  cat > "$tmp/ca.cnf" <<CNF
[ca]
default_ca = d
[d]
database = $tmp/index.txt
crlnumber = $tmp/crlnumber
default_md = sha256
default_crl_days = 26000
certificate = $cert
private_key = $k
CNF
  [ $# -gt 0 ] && openssl ca -config "$tmp/ca.cnf" -revoke "$1" 2>/dev/null
  openssl ca -config "$tmp/ca.cnf" -gencrl -out "$tmp/out.crl" 2>/dev/null
  openssl crl -in "$tmp/out.crl" -outform DER -out "$out"
}
crl int-revoked.crl.der int.crt int.key revoked.crt
crl int-empty.crl.der int.crt int.key
key evil
openssl req -new -x509 -key evil.key -subj '/O=GeckoMail Test/CN=Test Intermediate' -sha256 \
  -not_before "$FROM" -not_after "$UNTIL" -extensions int_evil -config <(printf '[req]\ndistinguished_name=d\n[d]\n[int_evil]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,cRLSign\n') -out "$tmp/evil.crt"
crl int-badsig.crl.der "$tmp/evil.crt" evil.key revoked.crt
rm evil.key

# Ad kısıtları: zincir kurucunun kaçırdığı dört atlatma ve denetim örnekleri
issue nc-int root nc_int '/O=GeckoMail Test/CN=NC Int'
issue nc-ok nc-int leaf_ok_example '/O=GeckoMail Test/CN=NC Ok'
issue nc-ctrl nc-int leaf_victim '/O=GeckoMail Test/CN=NC Control'
issue nc-sub nc-int nc_widen '/O=GeckoMail Test/CN=NC Sub'
issue nc-widen nc-sub leaf_victim '/O=GeckoMail Test/CN=NC Widen'
issue nc-anyof nc-int leaf_anyof '/O=GeckoMail Test/CN=NC AnyOf'
issue nc-dns nc-int leaf_dns '/O=GeckoMail Test/CN=NC Dns/emailAddress=ceo@victim.test'
issue nc-ex-int root nc_excl '/O=GeckoMail Test/CN=NC Excl'
issue nc-ex-leaf nc-ex-int leaf_nosan '/O=GeckoMail Test/CN=NC Ex/emailAddress=ceo@victim.test'
issue nc-bad-int root nc_bad '/O=GeckoMail Test/CN=NC Bad'
issue nc-bad-leaf nc-bad-int leaf_ok_example '/O=GeckoMail Test/CN=NC Bad Leaf'

# Özel SKI, nedenli CDP, aşırı büyük RSA
issue ski-custom int leaf_ski '/O=GeckoMail Test/CN=SKI Custom'
issue reasons-cdp int leaf_reasons '/O=GeckoMail Test/CN=Reasons CDP'
key rsa9000 9000
issue rsa9000 int alice '/O=GeckoMail Test/CN=RSA 9000'

# .p12: güncel ve eski biçim
cat int.crt root.crt > chain.pem
openssl pkcs12 -export -inkey alice.key -in alice.crt -certfile chain.pem -name alice -passout "pass:$P12_PASS" \
  -keypbe AES-256-CBC -certpbe AES-256-CBC -macalg sha256 -out alice-modern.p12
openssl pkcs12 -export -legacy -inkey alice.key -in alice.crt -certfile chain.pem -name alice -passout "pass:$P12_PASS" -out alice-legacy.p12
# Windows biçimi: yalnız 3DES; bir de RC2-128 sertifika kabı
openssl pkcs12 -export -legacy -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 -inkey alice.key -in alice.crt -certfile chain.pem -name alice \
  -passout "pass:$P12_PASS" -out alice-3des.p12
openssl pkcs12 -export -legacy -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-RC2-128 -macalg sha1 -inkey alice.key -in alice.crt -certfile chain.pem -name alice \
  -passout "pass:$P12_PASS" -out alice-rc2-128.p12

# OpenSSL'in ürettiği CMS örnekleri
printf 'Content-Type: text/plain; charset=utf-8\r\nFrom: alice@example.test\r\nSubject: fikstur\r\n\r\ngizli metin\r\n' > msg.eml
env() { openssl cms -encrypt -binary -outform DER -in msg.eml -out "$1" "${@:2}"; }
env env-aes-cbc.der -aes-256-cbc alice.crt
env env-aes-gcm.der -aes-256-gcm alice.crt
env env-oaep.der -aes-256-cbc -recip alice.crt -keyopt rsa_padding_mode:oaep -keyopt rsa_oaep_md:sha256
env env-3des.der -des3 alice.crt
env env-rc2-40.der -provider legacy -provider default -rc2-40 alice.crt
env env-des.der -provider legacy -provider default -des alice.crt
env env-ecdh.der -aes-256-cbc ec-p256.crt
sig() { openssl cms -sign -binary -nodetach -outform DER -in msg.eml -signer alice.crt -inkey alice.key -certfile int.crt -out "$1" "${@:2}"; }
sig sig-sha256.der -md sha256
sig sig-sha1.der -md sha1
sig sig-md5.der -md md5

# CRL kapsamı: IDP ve delta. crlx <çıktı> <uzantı satırları>; revoked.crt her birinde listelidir
crlx() {
  local out=$1
  shift
  : > "$tmp/index.txt"
  echo 01 > "$tmp/crlnumber"
  { cat <<CNF
[ca]
default_ca = d
[d]
database = $tmp/index.txt
crlnumber = $tmp/crlnumber
default_md = sha256
default_crl_days = 26000
certificate = int.crt
private_key = int.key
crl_extensions = x
[x]
CNF
    printf '%s\n' "$@"; } > "$tmp/cax.cnf"
  openssl ca -config "$tmp/cax.cnf" -revoke revoked.crt 2>/dev/null
  openssl ca -config "$tmp/cax.cnf" -gencrl -out "$tmp/out.crl" 2>/dev/null
  openssl crl -in "$tmp/out.crl" -outform DER -out "$out"
}
idp() { crlx "$1" 'issuingDistributionPoint = critical,@idp' '[idp]' "${@:2}"; }
idp crl-idp-match.der fullname=URI:http://crl.example.test/int.crl
idp crl-idp-other.der fullname=URI:http://crl.example.test/other.crl
idp crl-idp-ca.der fullname=URI:http://crl.example.test/int.crl onlyCA=TRUE
idp crl-idp-user.der fullname=URI:http://crl.example.test/int.crl onlyuser=TRUE
idp crl-idp-reasons.der fullname=URI:http://crl.example.test/int.crl onlysomereasons=keyCompromise
idp crl-idp-indirect.der fullname=URI:http://crl.example.test/int.crl indirectCRL=TRUE
idp crl-idp-attr.der fullname=URI:http://crl.example.test/int.crl onlyAA=TRUE
crlx crl-delta.der '2.5.29.27 = DER:02:01:01'

# GCM kabı içinde eski CBC zarfı: dış AEAD içteki CBC'nin bütünlüğünü kanıtlamaz
printf 'From: alice@example.test\r\nContent-Type: text/html\r\n\r\n<b>gizli</b>\r\n' > "$tmp/html.eml"
openssl cms -encrypt -binary -outform SMIME -aes-256-cbc -in "$tmp/html.eml" -out "$tmp/inner.eml" alice.crt
openssl cms -encrypt -binary -outform DER -aes-256-gcm -in "$tmp/inner.eml" -out env-gcm-over-cbc.der alice.crt
# özel SKI ile keyid imzası
openssl cms -sign -binary -nodetach -keyid -outform DER -in msg.eml -signer ski-custom.crt -inkey ski-custom.key -certfile int.crt -out sig-ski.der

printf '%s\n' "$P12_PASS" > p12-password.txt
