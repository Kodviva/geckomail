# Sunucu tarafı filtreler (Sieve)

Yalnız sunucu modunda. Kurallar ManageSieve ile posta sunucusuna `geckomail-rules` betiği olarak yüklenir, uygulama kapalıyken de çalışır. Ayarlar › Filtreler.

- Sunucunun yapamadığı eylem içeren kural ikiye bölünür: taşıma sunucuda, webhook, yönlendirme ya da bildirim istemci yarısında. İstemci yarısı için motor taşınan klasörü izler.
- Var olan bir betik varsa üzerine yazılmaz, onay istenir. Ham betik düzenleme yönetici içindir.
- Tatil yanıtı Sieve ile kurulur.
- Hesabın sunucu adresi değişince eski sunucudaki betik kaldırılır. Eski sunucuya ulaşılamıyorsa değişiklik reddedilir, yalnız yönetici betiğin orada kalmasını onaylayabilir.
- Hesap silinince betik kaldırılmaya çalışılır, başarısızlık silmeyi engellemez.

Masaüstünden sunucuya taşırken Sieve ayarları taşınmaz: betik posta sunucusunda kalır, çalışmayı sürdürür, ama sunucuda Sieve kapalı geldiği için istemci yarısı çalışmaz. Taşıma özeti bu hesapları tek tek uyarır. Taşıdıktan sonra Sieve'i açın.
