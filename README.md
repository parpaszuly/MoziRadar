# 🎬 MoziRadar

**Közös film- és sorozatkövető alkalmazás otthoni hálózatra.**

Mindenki saját profillal jelöli meg mit látott, mit szeretne megnézni, és 1–10-ig pontozhatja a filmeket. Az alkalmazás AI alapú személyes ajánlókat generál az ízlésed és pontozásaid alapján.

---

## Mit tud a MoziRadar?

- 👤 **Több felhasználó** — mindenki saját profillal, saját pontozásokkal és ajánlókkal
- 🎬 **Filmkövető** — látott / megnézném / folyamatban / nem érdekel állapotok
- ⭐ **Pontozás** — 1–10-es skálán
- 🔎 **Globális kereső** — a keresés kategóriától függetlenül az összes filmen/sorozaton keres
- ▶️ **YouTube trailer link** — minden film/sorozat részletes nézetében közvetlen trailer keresés
- 🔍 **Poszter nagyítás** — a részletes nézetben a poszter kattintásra teljes képernyőn jelenik meg
- 🤖 **AI ajánló** — a pontozásaid és ízlés leírásod alapján személyre szabott ajánlások
- 🎯 **Filmek alapján ajánló** — válassz ki 1–3 filmet és az AI hasonlókat ajánl
- 👥 **Közös este mód** — több ember alapján közös ajánló
- 📁 **Helyi filmek beolvasása** — ha van helyi filmmappád, automatikusan beolvassa és TMDB-n megkeresi
- 📊 **Profil statisztikák** — mennyi filmet láttál, kedvenc műfajok, pontozási eloszlás
- 📱 **Mobilbarát** — görgetős fülsor, alulról felcsúszó modális, telefon-optimalizált elrendezés
- 🌐 **LAN elérés** — a háztartásban bárki elérheti böngészőből

---

## Amire szükséged lesz

### Kötelező
- **[Docker Desktop](https://www.docker.com/products/docker-desktop/)** — ez futtatja az alkalmazást (ingyenes)
- **[Git](https://git-scm.com/downloads)** — a kód letöltéséhez (ingyenes)
- **TMDB API kulcs** — filmadatokhoz és poszterekhez (ingyenes, 2 perc alatt megszerezható)

### Opcionális (AI ajánlóhoz — az egyik elég)
- **Claude (Anthropic)** API kulcs — [console.anthropic.com](https://console.anthropic.com)
- **OpenAI** API kulcs — [platform.openai.com](https://platform.openai.com)
- **DeepSeek** API kulcs — [platform.deepseek.com](https://platform.deepseek.com) *(olcsóbb alternatíva)*
- **Google Gemini** API kulcs — [aistudio.google.com](https://aistudio.google.com)

> Ha egyelőre nem akarsz AI ajánlót, az is rendben van — minden más funkció működik nélküle.

---

## Telepítés lépésről lépésre

### 1. lépés — Docker Desktop telepítése

1. Menj a [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) oldalra
2. Kattints a **"Download for Windows"** gombra
3. Futtasd a letöltött telepítőt, következő-következő-befejezés
4. Indítás után a tálcán megjelenik a Docker bálna ikon 🐳
5. Várj amíg a bálna mozog → megáll (ez azt jelenti, hogy kész)

> **WSL2 hiba esetén:** Ha a telepítés közben WSL2-vel kapcsolatos hibát kapsz, fogadd el a frissítést, vagy kövesd a [Microsoft útmutatóját](https://learn.microsoft.com/hu-hu/windows/wsl/install).

---

### 2. lépés — Git telepítése

1. Menj a [git-scm.com/downloads](https://git-scm.com/downloads) oldalra
2. Kattints **"Download for Windows"**-ra
3. Telepítsd az alapértelmezett beállításokkal (mindenhol Tovább / Next)

---

### 3. lépés — MoziRadar letöltése

1. Nyisd meg a **Windows Terminal**-t vagy a **PowerShell**-t
   - Windows 11: jobb klikk az Asztalon → "Terminal megnyitása"
   - Windows 10: Start menü → keress rá "PowerShell"-re
2. Másold be és futtasd ezt a parancsot:

```
git clone https://github.com/parpaszuly/MoziRadar
```

3. Lépj be a letöltött mappába:

```
cd MoziRadar
```

---

### 4. lépés — Indítás

Futtasd ezt a parancsot (első alkalommal ez 3–5 percet vehet igénybe, letölti a szükséges komponenseket):

```
docker compose up --build -d
```

Ha kész, nyisd meg a böngészőt és menj erre a címre:

```
http://localhost:3421
```

Meg kell jelennie a MoziRadar beállítás varázslónak. Ha igen, minden működik! 🎉

> **A `-d` kapcsoló** azt jelenti, hogy a háttérben fut — a Terminal ablak bezárható, az alkalmazás tovább megy.

---

### 5. lépés — TMDB API kulcs megszerzése (ingyenes)

A TMDB (The Movie Database) biztosítja a film adatokat, posztereket és leírásokat.

1. Menj a [themoviedb.org](https://www.themoviedb.org) oldalra
2. Kattints **"Csatlakozás"** → regisztrálj egy fiókot (ingyenes)
3. Erősítsd meg az email címedet
4. A profil menüben menj a **Beállítások → API** menüpontra
5. Kattints az **"API kulcs kérése"** gombra → válaszd a **"Developer"** opciót
6. Töltsd ki az adatokat (bármilyen appnév megteszi, pl. "Otthoni MoziRadar")
7. Másold ki az **API kulcs (v3 auth)** értékét — erre lesz szükség

---

### 6. lépés — Első beállítás

Az alkalmazásban az első megnyitáskor a beállítás varázsló fogad:

1. **Admin neve** — a te neved (te leszel az adminisztrátor)
2. **Profilszín** — válassz egy kedvenc színt
3. **TMDB API kulcs** — illeszd be az előző lépésben másolt kulcsot
4. **AI szolgáltató** — ha van API kulcsod, válaszd ki és add meg (ha nincs, hagyd üresen)
5. Kattints az **"Indítás"** gombra

Ezután megjelenik a főoldal a filmes profilválasztóval.

---

## Használat

### Filmek / sorozatok hozzáadása

**Kézzel (bármely felhasználó):**
1. A könyvtár oldalon kattints a **"+ Hozzáadás"** gombra (a kereső mellett)
2. Válaszd a típust (film / sorozat) és írd be a címet
3. Kattints **"Hozzáadás"** — a TMDB automatikusan megkeresi a poszterét és adatait

**Kézzel (admin, több opció):**
1. A fejlécben kattints az **"Admin"** gombra → **"Katalógus"** fül
2. Ugyanúgy: típus + cím + Hozzáadás

**Helyi filmek beolvasása (ha van filmtárad — csak admin):**

Hozz létre egy `.env` nevű fájlt a MoziRadar mappában (Notepad-del is megnyitható), és írd bele:

```
MEDIA_PATH=D:\Filmek
```

*(Cseréld ki a saját filmeid mappájának elérési útjára)*

Majd állítsd le és indítsd újra az alkalmazást:

```
docker compose down
docker compose up --build -d
```

Ezután: **Admin → Katalógus → "Filmek beolvasása"** gomb — az alkalmazás végigmegy a mappán, minden filmet megkeres a TMDB-n és hozzáadja a katalógushoz.

> **Fontos:** A beolvasás nem automatikus. Ha később új film kerül a mappába, a gombot újra meg kell nyomni — csak az újak kerülnek be, a már meglévők nem duplázódnak.

---

### Felhasználók hozzáadása

Ha többen használjátok (pl. partner, szobatárs):

1. **Admin → Felhasználók → Új felhasználó**
2. Adj meg nevet és válassz színt
3. Opcionálisan írd le az ízlését (ez segíti az AI ajánlót)
4. Kattints **"Hozzáadás"**

Amikor valaki megnyitja az alkalmazást, a főoldalon a "Ki néz ma?" képernyőn választja ki a saját profilját.

---

### Filmek értékelése

1. Kattints egy filmre a katalógusban
2. A felugró ablakban állítsd be az állapotot:
   - **Láttam** — és adj pontszámot 1–10-ig
   - **Megnézném** — watchlista
   - **Folyamatban** — éppen nézed
   - **Nem érdekel** — kizárod az ajánlókból
3. Az állapot automatikusan mentődik

---

### AI ajánló használata

Az **"Ajánló"** fülön két módban kérhetsz AI ajánlókat:

**1. Személyes ajánló (pontozások alapján)**
- Kattints az **"AI ajánlókat kérek"** gombra
- Az AI a pontozásaid és ízlés leírásod alapján ajánl 8 filmet/sorozatot
- Az ajánlott filmek TMDB névvel, poszterrel és indoklással jelennek meg

**2. Filmek alapján ajánló**
- Kattints a **"Filmek alapján"** gombra
- Egy felugró ablakban megjelennek a már látott filmjeid
- Keress rájuk, és jelölj ki 1–3 filmet
- Kattints az **"Ajánlást kérek"** gombra
- Az AI kizárólag a kijelölt filmek stílusa, hangulata és témái alapján ajánl — az általános ízlés leírásod nem befolyásolja
- A panel fejlécében látod, melyik filmek alapján készült az ajánló

> **Hogyan működik az AI ajánló?**
> - *Személyes mód:* A látott és pontozott filmjeid + ízlés leírásod alapján következtet az ízlésedre
> - *Filmek alapján mód:* Kizárólag a kijelölt referencia filmekhez hasonlókat keres (stílus, hangulat, műfaj)
> - Mindkét módban kizárja amit már láttál, watchlistre vagy "nem érdekel"-re tettél

---

### Profil személyre szabása

Kattints a fejlécben a **saját nevedre vagy avatarodon** a profil megnyitásához:

- **Profilszín** módosítása
- **Ízlés leírása** — rövid szöveg arról milyen filmeket szeretsz (ez kerül az AI promptba)
- **Statisztikák** — hány filmet láttál, átlag pontszámod, kedvenc műfajok, pontozási eloszlás

---

### Közös este mód

Az **"Ajánló"** fülön a **"Közös este"** szekcióban:

1. Pipáld be kik néznek ma együtt
2. Kattints a **"Mehet"** gombra
3. Az alkalmazás olyan filmeket ajánl, amiket senki nem látott még, és amiket valaki a csoportból magasra értékelt

---

## Frissítés

Ha megjelenik egy új verzió, nyisd meg a Terminal-t a MoziRadar mappában és futtasd:

```
git pull
docker compose down
docker compose up --build -d
```

> ✅ **Az adatbázis (filmek, értékelések, felhasználók) megmarad** — a Docker volume tárolja, nem törlődik frissítéskor.

⚠️ **Fontos:** Ne használd a `docker compose down -v` parancsot (a `-v` kapcsoló törli az adatbázist is).

---

## Elérés más eszközökről (LAN)

Az alkalmazás a helyi hálózaton más telefonokról, tabletekről és számítógépekről is elérhető.

1. Keresd meg a gép IP-jét ahol fut: Start menü → `cmd` → `ipconfig` → **IPv4 cím** (pl. `192.168.1.105`)
2. Más eszközön böngészőben nyisd meg: `http://192.168.1.105:3421`

---

## Leállítás és újraindítás

**Leállítás** (adatbázis megmarad):
```
docker compose down
```

**Újraindítás:**
```
docker compose up -d
```

**Teljes törlés** (⚠️ mindent töröl, beleértve az adatbázist):
```
docker compose down -v
```

---

## Gyakori kérdések

**Nem nyílik meg a `http://localhost:3421` oldal**
- Ellenőrizd, hogy a Docker Desktop fut-e (tálcán a bálna ikon)
- Futtasd: `docker compose ps` — a `moziradar` sorban `running` állapotnak kell lennie
- Próbálj meg másik portot, ha valami már foglalja: `docker compose down`, szerkeszd a `docker-compose.yml`-ben a `"3421:3421"`-et pl. `"3422:3421"`-re, majd `docker compose up -d`

**A filmeknek nincs poszterük / nem találja őket**
- Ellenőrizd a TMDB API kulcsot: Admin → Beállítások
- A kulcsnak "v3 auth" típusúnak kell lennie (nem "v4 access token")

**Az AI ajánló nem működik**
- Ellenőrizd az AI API kulcsot: Admin → Beállítások
- A szolgáltató és a kulcs típusának egyeznie kell (pl. ha Claude-ot választottál, Anthropic kulcs kell)
- Legalább néhány pontozott filmednek kell lennie (vagy töltsd ki az ízlés leírást a profilban)

**Frissítés után elvesztek az adatok**
- Valószínűleg `docker compose down -v`-t használtál a `-v` nélkül kell: `docker compose down`
- Ellenőrizd: `docker volume ls | findstr moziradar` — ha látod a volume-ot, az adatok megvannak

---

## Technikai részletek

| Komponens | Technológia |
|-----------|-------------|
| Backend | Node.js + TypeScript |
| Adatbázis | SQLite (better-sqlite3) |
| Frontend | Vanilla JS, CSS (keretrendszer nélkül) |
| Filmadatok | TMDB API |
| AI ajánló | Claude / OpenAI / DeepSeek / Gemini |
| Futtatás | Docker |
