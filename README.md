# ⭐ Şampiyonlar Ligi Tahmin Ligi

Şirket içi tahmin yarışması. Her maç için **1 / X / 2**, istersen ek olarak skor tahmini.
Sunucu yok, aylık ücret yok — GitHub Pages (site) + Supabase (kullanıcı & tahmin) ücretsiz
katmanlarında çalışır.

**Puanlama**
| Durum | Puan |
|---|---|
| 1/X/2 doğru | **3** |
| Üstüne tam skor da doğru | **+2 bonus** |
| Skor yanlış | ceza yok |

**Kilit:** Her maçın tahmini kendi başlama saatinde kilitlenir. Yani 19:45 maçları
19:45'te, 22:00 maçları 22:00'de kapanır.

**Görünürlük:** Başkalarının tahminleri ancak **maç bittikten sonra** açılır — maç oynanırken
herkes yalnızca kendi tahminini görür.

---

## Kurulum (yaklaşık 15 dakika, tek seferlik)

Aşağıdaki adımları **yalnızca sen** yapıyorsun. Katılımcıların GitHub hesabına ihtiyacı yok;
onlar sadece site adresine girip e-posta + şifre ile kayıt oluyor.

### 1) Football-Data API anahtarı (ücretsiz)

1. https://www.football-data.org/client/register adresinden kayıt ol.
2. E-postana gelen **API token**'ı sakla.
   Ücretsiz plan Şampiyonlar Ligi'ni kapsar (dakikada 10 istek — bizim için fazlasıyla yeter).

### 2) Supabase projesi (ücretsiz)

1. https://supabase.com → **New project**. Bölge olarak *Frankfurt (eu-central-1)* iyi bir seçim.
2. Sol menüden **SQL Editor → New query**: bu repodaki `supabase/schema.sql` dosyasının
   tamamını yapıştır ve **Run**. (Tablolar, güvenlik kuralları ve puan tablosu oluşur.)
3. **Authentication → Sign In / Providers → Email**: `Confirm email` seçeneğini **kapat**.
   Uygulama e-posta sormuyor; kullanıcı adından `ad@ucl-tahmin.local` biçiminde görünmez bir
   adres üretiyor. Bu ayar açık kalırsa gerçek olmayan adrese doğrulama maili gitmeye
   çalışacağı için kimse giriş yapamaz.
4. **Settings → API** sayfasından şu üç değeri not et:
   - `Project URL`
   - `anon public` anahtarı
   - `service_role` anahtarı ← **bu gizlidir, sadece GitHub Secret olarak kullanılacak**

### 3) Repoyu yayına al

1. Bu klasörü kendi GitHub hesabında **public** bir repo olarak yayınla:
   ```bash
   gh repo create ucl-tahmin --public --source=. --push
   ```
2. `config.js` dosyasını aç, `Project URL` ve `anon public` anahtarını yaz, kaydet ve gönder:
   ```bash
   git commit -am "Supabase bilgileri" && git push
   ```
   > `anon` anahtarının herkese açık olması normaldir; veriyi `schema.sql` içindeki RLS
   > kuralları korur. `service_role` anahtarını **asla** bu dosyaya yazma.
3. **Settings → Pages**: *Source* = `Deploy from a branch`, *Branch* = `main` / `/ (root)` → Save.
   Bir iki dakika içinde siten yayında olur:
   `https://<kullanıcı-adın>.github.io/ucl-tahmin/`
4. **Settings → Secrets and variables → Actions → New repository secret** ile üç sır ekle:

   | İsim | Değer |
   |---|---|
   | `FOOTBALL_DATA_TOKEN` | football-data.org token'ın |
   | `SUPABASE_URL` | Supabase Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase `service_role` anahtarı |

5. **Actions** sekmesi → *Maçları senkronla* → **Run workflow** ile fikstürü ilk kez çek.
   Bundan sonra yarım saatte bir kendiliğinden çalışır; hem fikstürü hem canlı sonuçları günceller.

### 4) Linki paylaş

Arkadaşlarına tek bir adres gönderiyorsun. Girip "Kayıt ol" diyorlar, **kullanıcı adı ve
şifre** belirliyorlar, tahmin yapmaya başlıyorlar. E-posta istenmiyor.

> Şifresini unutan olursa: Supabase → Authentication → Users listesinden kullanıcıyı bulup
> "Reset password" ile yeni şifre belirleyebilirsin. Kullanıcı adı `ad@ucl-tahmin.local`
> biçiminde görünür.

---

## Sık sorulanlar

**Maçları nasıl geziyoruz?**
Gün gün. Üstteki seçiciden tarihi değiştiriyorsun; o güne ait maçlar ve bir sonraki kilide
kalan süre görünüyor. Seçtiğin butona tekrar basarsan tahmin tamamen kalkar.

**Başkalarının tahminlerini nasıl görüyoruz?**
"Tahminler" sekmesinden. Gün ve kişi filtresi var; bir maça tıklayınca herkesin 1/X/2
seçimi, varsa skor tahmini ve kazandığı puan açılıyor — maç bittikten sonra. Kişi seçince o oyuncunun sezon
toplamı da üstte çıkıyor.

**Tahminler gerçekten gizli mi?**
Evet. Veritabanı kuralları, bir kullanıcının başkasının tahminini maç kilitlenmeden
okumasını engeller — arayüzde gizlemekle kalmıyoruz, sunucu seviyesinde de erişemiyor.

**Sonuçlar ne zaman işleniyor?**
GitHub Actions yarım saatte bir sonuçları çekiyor; puan tablosu bunun üzerinden anlık
hesaplanıyor. Sonucu elle girmen gerekmiyor.

**Uzatma / penaltılar?**
1/X/2 için maçın normal süre + uzatma sonucu (football-data'nın `fullTime` skoru) esas alınır;
penaltı atışları puanlamayı etkilemez.

**Başka bir lig de yapabilir miyim?**
`.github/workflows/sync-matches.yml` içine `COMPETITION` ortam değişkeni ekle:
`PL` (Premier Lig), `BL1`, `SA`, `PD`, `FL1`, `EL` gibi kodlar ücretsiz planda mevcut.
Süper Lig ücretsiz planda yok.

**Kendi alan adımı bağlayabilir miyim?**
Evet, GitHub Pages ayarlarından *Custom domain* ile ücretsiz (HTTPS dahil).

---

## Sohbet

Sağ alttaki 💬 baloncuğundan açılan küçük bir pencerede grup mesajlaşması var — sekme
kaplamıyor. Supabase Realtime üzerinden anlık çalışır; mesajlar 500 karakterle sınırlı,
herkes yalnızca kendi mesajını silebilir.

`@` yazınca oyuncu listesi açılır, ok tuşları veya tıklamayla seçilir. Etiketler mesajda
vurgulanır; seni etiketleyen mesajın kenarı altın rengine döner. Okunmamış mesaj sayısı
baloncuğun üstünde rozet olarak görünür.

Kurulum: `supabase/chat.sql` dosyasını SQL Editor'de bir kez çalıştır.

## Kupon

Maçlar sekmesinin altındaki "🧾 Bu günün kuponunu paylaş" butonu, o güne ait tahminlerini
kâğıt fiş görünümünde bir PNG olarak üretir. Telefonda paylaşım menüsü açılır, masaüstünde
dosya iner. Görüntü tamamen tarayıcıda `canvas` ile çizilir, harici kütüphane kullanılmaz.

## Bekçi (ikinci güvenlik hattı)

GitHub Actions'ın zamanlanmış görevleri garantili değil — 8 Eylül 2026'da 85 dakika hiç
çalışmadı, maçlar `IN_PLAY` durumunda dondu ve puanlar işlenmedi. Buna karşı üç katman var:

1. **Takip modu** — senkron, maç bitene kadar 3 dakikada bir tazeler; tek çalıştırma bütün
   maç akşamını kapatır (`WATCH=1`).
2. **Bekçi** — Supabase içindeki `pg_cron`, 10 dakikada bir "maç saati mi ve veri 12
   dakikadan eski mi?" diye bakar, öyleyse GitHub akışını tetikler. GitHub'a bağlı değildir.
   Kurulumu: `supabase/watchdog.sql` (dosyanın başındaki adımlar).
3. **Uygulama** — maç saatlerinde 2 dakikada bir kendi verisini tazeler ve alt bilgide
   sonuçların ne zaman güncellendiğini gösterir; 15 dakikayı geçerse uyarır.

Bekçinin durumunu görmek için SQL Editor'de:

```sql
select * from public.watchdog_durum limit 10;
```

`status_code` 204 ise tetikleme başarılı. 401/403 görürsen GitHub token'ının süresi
dolmuştur; yenisini üretip `watchdog.sql`'in 2. adımını tekrar çalıştır.

## Logo hakkında

`assets/` altındaki görseller UEFA Şampiyonlar Ligi logosundan türetildi (koyu temada
okunabilmesi için beyaza boyandı). Logo UEFA'nın tescilli markasıdır; şirket içi, ticari
olmayan bir tahmin ligi için kullanılıyor. Ticari bir işte kullanacaksan kendi logonla
değiştir: `assets/ucl-logo.png` (giriş ekranı), `assets/ucl-ball.png` (üst bar),
`assets/favicon.png` (sekme ikonu).

## Dosya düzeni

```
index.html                       arayüz iskeleti
assets/                          logo ve favicon
styles.css                       koyu UCL teması
app.js                           tüm uygulama mantığı
config.js                        Supabase URL + anon key (senin dolduracağın yer)
supabase/schema.sql              tablolar, güvenlik kuralları, puan tablosu
supabase/chat.sql                sohbet tablosu ve kuralları
supabase/watchdog.sql            pg_cron bekçisi
scripts/sync-matches.mjs         football-data.org → Supabase senkronu
.github/workflows/sync-matches.yml  yarım saatlik zamanlanmış görev
```
