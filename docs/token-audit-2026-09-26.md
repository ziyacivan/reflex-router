# reflex token denetimi (2026-09-26)

**Soru.** reflex token tüketimini artırıyor mu? Amaç tasarruftu; gerçekte ne oluyor, Jev tarafında düzeltilecek bir
şey var mı?

**Kısa cevap.** Evet, 22–26 Eylül arasında, `~/.reflex/env`'deki ayarlarla reflex **tasarruf ettirmedi, fazladan
harcattı**. Bu fazlanın en büyük kısmı zaten düzeltilmiş bir hatadan geliyor. Kalan iki kaynak bir ayar ve bir
politika varsayımı: effort'un yukarı çekilmesi (`REFLEX_EFFORT_UP`) ve Opus 5.5'ten Sonnet 5'e yönlendirmenin ucuz
sayılması. Rapor ve durum satırındaki "Est. Saved" rakamı da gerçek tasarrufu birkaç kat büyük gösteriyor.

Tüm dolar rakamları `src/pricing.ts` liste fiyatlarıyla, kaydedilen token sayıları üzerinden yapılmış **tahminlerdir,
fatura değildir**. Hesap OAuth (abonelik) ile kullanılıyor, yani gerçek "maliyet" kullanım limitidir; dolar burada
sadece kıyas ölçüsü.

## Neye bakıldı

| Kaynak | İçerik |
| --- | --- |
| `~/.reflex/decisions.jsonl` | 4.037 istek, 758 oturum, 2026-09-22 15:21Z → 09-26 15:47Z, ~516M token, ~$257 (liste) |
| Claude Code dökümleri (`~/.claude/projects`) | 7.584 yanıt, 2026-08-28 → bugün. reflex loguyla token sayılarından eşleştirildi, böylece hangi oturumun reflex'ten geçtiği belli |
| Rastgele kontrol grupları | `REFLEX_AB=0.5` (yönlendirme) ve `REFLEX_EFFORT_AB=0.2` (effort). "Şu şuna yol açtı" diyebildiğimiz tek veri bu |

İş birimi = yeni bir tur + aynı konuşmadaki tool-loop devamları (alt-ajan için tüm koşusu). Güven aralıkları 4.000
tekrarlı bootstrap ile hesaplandı (%95).

## Bulgular

### 1. 25 Eylül'e kadar her istek ~34 bin fazla token taşıyordu (düzeltildi)

reflex 0.5.5 ve öncesinde Claude Code, base URL birinci taraf olmadığı için tool search'ü kapatıyordu; bu yüzden her
istekte bütün araç şemaları gidiyordu (bilinen hata, 0.5.6'da düzeltildi; global kurulum şu an 0.5.7).

| Oturum grubu | İlk turun bağlamı |
| --- | --- |
| reflex'ten önce (28 Ağu–15 Eyl) | ~38k |
| aynı günler, reflex'siz | ~42k |
| reflex ≤0.5.5 | **~76k** |
| reflex 0.5.7 | ~42k |

Loglu dönemde (22 Eyl → 25 Eyl 10:32Z) 1.734 ana-sohbet isteği × ~34k ≈ **59M token**. Bu, o dönemdeki etkileşimli
tokenlerin ~%12,5'i, liste fiyatıyla **~$15**. Alt-ajanlar sayılmadı; 19–21 Eylül'ün logu yok. Yani gerçek rakam
daha büyük.

### 2. Sonnet'e yönlendirmek token sayısını artırıyor, parayı neredeyse hiç azaltmıyor

En temiz veri, 24–26 Eylül'deki toplu `claude -p` işleri: 681 tek istekli görev. Bunlar rastgele ikiye bölündü (Jev
Sonnet dedi, yarısı Opus'ta tutuldu) ve iki kolda da effort aynıydı (`high`). İki kol denk: reasoning puanı
ortalaması 1,84 ve 1,79, Jev'e giden metin 2.947 ve 2.861 karakter, aynı saatlerde.

| | Opus 5.5'te kaldı (n=321) | Sonnet 5'e gitti (n=360) | Fark [%95 aralık] |
| --- | --- | --- | --- |
| çıktı token / görev | 1.212 | 3.222 | **+%150** [+129, +173] |
| toplam token / görev | 12,2k | 15,0k | **+%18** [+13, +24] |
| maliyet / görev | $0,0424 | $0,0421 | **−%4** [−12, +4], sıfırdan ayırt edilemiyor |

Sonnet 5 aynı işi yaklaşık 2,7 kat daha fazla düşünerek yapıyor. 24 Eylül'deki kontrollü bulmaca deneyi de aynı yönü
göstermişti (`docs/observations.md`: Sonnet `high` 5.626 çıktı token'ı, Opus 5 `high` 2.354).

**Neden para kazandırmıyor:** Opus 5.5'in fiyatı ($4 / $20) Sonnet 5'in ($2 / $10) sadece iki katı, önbellekten
okuma ise ikisinde de aynı ($0,20/M). Sonnet çıktıda token başına yarı fiyat ödüyor ama 2,7 kat token üretiyor, yani
çıktı maliyeti Sonnet'te **%33 daha yüksek**. Tek kazancı önbellek yazımında, sonuçta aşağı yukarı başa baş. Tokenlerin
%73'ü, önbellek okumasının baskın olduğu tool-loop'larda harcanıyor; orada Sonnet'e geçmek zaten bir şey
kazandırmaz.

Haiku farklı: $1 / $5, önbellek okuma $0,10. Gerçekten ucuz, ama az kullanıldı (30 kayıt).

### 3. "Est. Saved" (rapor bölüm 8 ve durum satırı) tasarrufu şişiriyor

`savedUsd` gönderilen modelin harcadığı token'ı alıyor ve "istenen modelde olsaydı" diye istenen modelin fiyatıyla
çarpıyor. Yani Opus'un da Sonnet kadar token üreteceğini varsayıyor. Bulgu 2 bunun yanlış olduğunu gösteriyor.

| | Rapor yöntemi | A/B'ye göre gerçek |
| --- | --- | --- |
| Toplu işler (Opus → Sonnet/Haiku) | $15,3 tasarruf | **~$0,6** (sıfır da olabilir) |
| Tüm log | $17,47 tasarruf | çok daha az (aşağıda) |

Durum satırındaki "Total Saved" aynı fonksiyonu kullanıyor (`src/worker/session-status.ts` → `savedUsd`).

### 4. `REFLEX_EFFORT_UP` senin `low` seçimini yukarı çekiyor

24–26 Eylül'deki etkileşimli oturumlarda effort `low` idi (78 tur). reflex 68 turda bunu yükseltti: low→medium 32,
low→high 20, low→xhigh 10, medium→high/xhigh 6. Sebep: Jev'in reasoning puanı birebir effort'a çevriliyor (0 low,
1 medium, 2 high, 3 xhigh, 4 max) ve "rutin iş" (puan ~1) `medium` oluyor.

Rastgele kontrolle kıyas (yükseltilen 68 tur, `low`'da bırakılan 20 tur):

| | Fark [%95 aralık] |
| --- | --- |
| maliyet / tur (ortalama) | +%46 [−30, +257] |
| maliyet / tur (medyan) | +%57 [−13, +176] |
| tur başına istek (medyan) | +%67 [0, +250] |

Kontrol grubu küçük (20). Yön net (daha çok düşünme, daha çok adım; effort'un çıktıyı artırdığı kontrollü deneyde de
ölçülmüştü), ama büyüklük kesin değil. Nokta tahmini ~$12 fazladan.

Ters yön olumlu: Opus'ta effort'u high'tan medium'a düşürmek (toplu işler, 49'a 11) çıktıyı −%13, medyan maliyeti
−%21 azalttı (aralıklar sıfırı içeriyor). Opus 5.5'te effort değiştirmek önbelleği bozmuyor (ölçülmüştü).

### 5. Küçük sızıntılar

- **Alt-ajan yan çağrıları yanlış modelde (düzeltildi, 0.5.7).** Konuşma Sonnet'teyken özet çağrıları Opus'a gidip
  ayrı önbellek yazıyordu: 34 istek, 0,85M token, ~$3.
- **Upgrade'ler (düzeltildi).** 22–23 Eylül'de Sonnet/Haiku istenen alt-ajanlar Opus'a çıkarıldı: ~$4 fazla (eski pin
  hatası ve açık model seçiminin ezilmesi).
- **Hâlâ açık: sınıflandırılamayan ana-sohbet istekleri pin'i takip etmiyor.** 26 Eylül'de konuşma Sonnet'teyken iki
  istek (biri `!pwd` bash modu girdisi) Opus'a gitti ve 72k + 83k token önbellek yazdı (~$0,8). Kaynak: rapor bölüm
  11'deki `no_typed_prompt` parmak izleri.
- **Önbellek genel olarak sağlam.** İsabet oranı reflex'li ve reflex'siz oturumlarda aynı: %98,7 ve %98,0, reflex
  öncesi %99,0. Model veya effort değişiminden kaynaklanan ekstra yeniden yazım toplamda birkaç dolar.

### 6. Token dışı ama not edilmeli

- **Jev:** 1.004 karar, toplam ~1,85M Jev girdi token'ı (TypeSafe faturası, Anthropic'ten ayrı), karar başına p50
  350 ms bekleme. Toplu işlerde karar başına ~2,1k token, etkileşimlide ~1,3k. Alt-ajan kararlarının %20'si zaman
  aşımına uğruyordu (0.5.7'de düzeltildi; sonrası için veri az).
- **Laya:** `REFLEX_COMPARE=laya` hâlâ açık. Her oturum bir laya-serve başlatıyor (2–5 sn yükleme), oysa Laya işi 24
  Eylül'de kapatıldı. Ayrıca şu an 1–2 gündür çalışan **8 sahipsiz `laya-serve`** var (ebeveyn PID 1): laya-guard
  bunları öldürememiş.

## Genel bilanço (22–26 Eylül, liste fiyatı tahmini)

| Kalem | Etki |
| --- | --- |
| Tool search hatası | **+~$15** (düzeltildi) |
| Upgrade'ler + yan çağrı sızıntıları | **+~$8** (çoğu düzeltildi) |
| Effort yükseltme | muhtemelen **+~$12** (kesin değil) |
| Yönlendirmenin gerçek tasarrufu | **−$1 … −$7** (toplu işlerde ~$0,6; etkileşimlide rapor $6 diyor, gerçeği daha az) |

**Net:** toplam ~$257'lık harcamada reflex ~%6–13 fazladan harcattı. 0.5.7 ile en büyük kalem ortadan kalktı. Kalan
fazlalık ayar ve politika kaynaklı.

## Jev tarafında ne yapılmalı

Jev'in kararları kendi sorusuna göre makul. Sorun, sorduğumuz sorunun ve cevabı kullanma şeklimizin maliyetle
hizalı olmaması.

1. **Opus 5.5 istendiğinde Sonnet'e geçme; effort'u düşür.** Jev "sonnet yeter" dediğinde Opus 5.5'te kal ve effort'u
   bir kademe indir. Bu hem önbelleği korur hem Sonnet'in fazla düşünmesinden kaçınır. Haiku yönlendirmesini sadece
   mekanik işler için tut.
2. **Soruyu maliyete bağla.** Şu anki soru "işi iyi yapacak en düşük katman hangisi?"; reflex bunu "en ucuz" diye
   okuyor. Ya Jev'e (model, effort) çifti sorulmalı, ya da reflex Jev'in cevabını ölçülmüş token çarpanlarıyla
   beklenen maliyete çevirip en ucuz yeterli seçeneği almalı (örneğin Sonnet 5 ≈ 2,7 × Opus 5.5 çıktı).
3. **Effort haritasını bir kademe aşağı kaydır:** rutin (1) → low, orta (2) → medium, zor (3) → high, açık uçlu (4) →
   xhigh. Toplu işlerde Jev puanının medyanı 1,88; bu şu an `high` demek.
4. **Tasarruf hesabını A/B'ye bağla.** Bölüm 8 ve durum satırı, kontrol kolundan ölçülen token oranını kullanmalı ya
   da en azından "A/B'ye göre" satırı göstermeli. Yoksa reflex her zaman tasarruf ediyormuş gibi görünür.
5. **Tek atımlık `claude -p` işlerinde karar değeri düşük.** 700 karar 350 ms ve ~2,1k Jev token'ı ekledi, para
   kazandırmadı. Jev'e giden metin de kısaltılabilir (toplu işlerde ~3k karakter); karar kalitesine etkisi harvest
   korpusuyla test edilmeli.

## Kod gerektirmeyen hızlı adımlar (`~/.reflex/env`)

- `REFLEX_EFFORT_UP=1` açık kalıyor (sahibin kararı: Jev effort yükseltmek istiyorsa haklı olabilir). Maliyeti artırdığı biliniyor; karşılığında kalite kazandırıp kazandırmadığı bölüm 14 ile izlenecek.
- `REFLEX_TIERS=haiku,opus` ekle: Opus → Sonnet yönlendirmesi durur (Jev Sonnet dediğinde istenen modelde kalır),
  Haiku kalır.
- `REFLEX_UPGRADES=on` satırını sil: upgrade'ler tanımı gereği maliyeti artırır.
- `REFLEX_COMPARE=laya` satırını sil.
- Sahipsiz laya-serve süreçlerini kapat: `pkill -f laya-serve` (açık reflex oturumu yokken).

## Sınırlar

- Tek makine, tek kişi, 4,5 gün. Randomize verinin çoğu toplu `claude -p` işlerinden geliyor. Bunlar bir SEO aracının
  başlattığı metin üretme görevleri; reflex başlatmadı, sadece açık bir reflex oturumunun `ANTHROPIC_BASE_URL`'ini
  miras aldıkları için reflex'ten geçtiler. Kodlama işinde Sonnet çarpanı farklı olabilir.
- Etkileşimli ana sohbette yönlendirme A/B'si sonuç vermiyor: "routed" kolundaki 25 turun 21'ini maliyet koruması
  zaten Opus'ta tuttu.
- Effort A/B'sinde kontrol grubu 20 tur; büyüklük kesin değil.
- Kalite (düzeltme oranı) hâlâ ölçülemiyor: routed 26 / control 43 pencerede birer düzeltme var.
- Tüm dolarlar liste fiyatı tahmini. 1 saatlik önbellek yazımı (Claude Code'un kullandığı) 5 dakikalık fiyattan
  pahalıdır; burada 5 dakikalık fiyat kullanıldı, dolayısıyla yazım kaynaklı fazlalar biraz eksik hesaplandı.
