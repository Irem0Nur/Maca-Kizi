# Maça Kızı V3

Bu sürümde:

- Kartlar büyütüldü.
- Kartlar daha gerçek iskambil kartı görünümünde çiziliyor.
- Sinek 2 sadece ilk oyuncuyu belirliyor.
- Sinek 2 sahibi, kurallara uygun olmak şartıyla istediği kartı oynayabiliyor.
- 5 Kafa VEYA 175 ceza puanı oyunu kaybettiriyor.
- Oyun sonunda tam ekran skor/sonuç tablosu açılıyor.
- Bot kart atma animasyonları korunuyor.
- 1 oyuncu + 3 bot ve online oda modu korunuyor.

Çalıştırma:

npm install
npm start

Sonra:
http://localhost:3000

Kafa sesi için istersen public/kafa.mp3 dosyası ekleyebilirsin.


## V3.1 düzeltmesi
- Dördüncü oyuncunun attığı kart artık anında kaybolmaz.
- 4. kart yaklaşık 1.3 saniye masada görünür.
- Ardından elin kazananı hesaplanır ve yeni ele geçilir.
- Düzeltme hem bot hem online modda çalışır.


## V4
- Kaybetme sınırı: 5 Kafa VEYA 180 ceza.
- Peşkir gerçek oyuncuya sorulur; Evet/Hayır seçilebilir.
- Botlar uygun olduğunda Peşkir hakkını otomatik kullanır.
- Oynanamayacak kartlarda ⛔ işareti görünür.
- Kart figürleri ve büyük değerler çakışmayacak şekilde düzenlendi.


## V5
- Peşkir seçimi artık kartlar dağıtılır dağıtılmaz yapılır.
- En az 35 toplam cezası olan oyuncu tur başında Peşkir ilan edebilir.
- Peşkir ilan eden oyuncu tur sonunda hiç el almamışsa -35 alır.
- Peşkir ilan edip el alırsa Peşkir bozulur.
- Peşkir EVET/HAYIR cevapları diğer oyuncuların ekranında da görünür.
- Her hamle için 20 saniye süre vardır.
- Sayaç tüm oyuncular tarafından görülür.
- Süre biterse sunucu geçerli kartlardan birini otomatik oynar.


## V6 düzeltmeleri
- Peşkir artık her tur kartlar dağıtılır dağıtılmaz HER oyuncuya sorulur.
- İnsan oyuncunun Peşkir penceresi bot cevaplarından önce görünür.
- Bot cevapları sırayla masaya yansır.
- Peşkir EVET/HAYIR cevapları herkes tarafından görülür.
- Peşkir -35 indirimi yalnızca tur sonunda şartlar sağlanırsa uygulanır.
- Sayısal kartların pip yerleşimi baştan yapıldı.
- Alt ters köşe indeksi kaldırıldı; orta semboller köşe değerleriyle artık çakışmaz.
- 10 gibi yoğun kartlarda semboller güvenli orta alana yerleştirilir.


## V7 Peşkir akışı
1. Kartlar dağıtılır.
2. Oyuncunun 13 kartı ekranda tamamen görünür.
3. Yaklaşık 1.2 saniye sonra Peşkir Evet/Hayır penceresi açılır.
4. Peşkir kararı verilene kadar kart oynanamaz ve hamle sayacı başlamaz.
5. Oyuncuların Peşkir cevapları diğer oyuncular tarafından görülür.
6. Tüm kararlar tamamlanınca oyun ve 20 saniyelik hamle süresi başlar.


## V7.1
- Kartlar dağıtıldıktan sonra Peşkir penceresi artık 5 saniye bekler.
- Bu 5 saniye oyuncunun elindeki kartları inceleme süresidir.
- İnceleme sırasında hamle sayacı başlamaz ve kart oynanamaz.
- Botların Peşkir cevapları da bu inceleme süresinden sonra görünmeye başlar.
