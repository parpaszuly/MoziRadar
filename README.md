# MoziRadar

Közös filmkövető és ajánló app házi hálózatra. Mindenki saját profillal pontozza a filmeket és sorozatokat, és AI ajánlót kap.

## Telepítés

**Követelmények:** [Docker Desktop](https://docs.docker.com/desktop/install/windows-install/)

```bash
git clone https://github.com/parpaszuly/MoziRadar
cd MoziRadar
docker compose up --build
```

Böngészőben: **http://localhost:3421**

LAN-on más gépekről: **http://[gép IP-je]:3421**

## Első indítás

Az első megnyitáskor a setup wizard kéri:
- **Admin neve** (a te neved)
- **TMDB API kulcs** (ingyenes, [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api))
- **AI ajánló** (opcionális -- Claude, OpenAI, DeepSeek, Gemini)

## Helyi filmek beolvasása (opcionális)

Hozz létre `.env` fájlt a mappában (a `.env.example` alapján):

```
MEDIA_PATH=D:\Filmek
```

Majd indítsd újra:

```bash
docker compose up --build
```

Ezután az Admin -> Katalógus -> "Filmek beolvasása" gomb beolvassa a mappát, TMDB-n megkeresi a posztereket és hozzáadja a katalógushoz.

## Használat

- Filmek/sorozatok hozzáadása: Admin gomb -> Katalógus
- Helyi filmek beolvasása: Admin gomb -> Katalógus -> Filmek beolvasása
- Új felhasználó (pl. partner): Admin gomb -> Felhasználók -> Új felhasználó
- API kulcsok módosítása: Admin gomb -> Beállítások
- AI ajánló generálás: Admin gomb -> Ajánló

## Frissítés

```bash
git pull
docker compose up --build
```

Az adatbázis megmarad (Docker volume).

## Reset (töröl mindent)

```bash
docker compose down -v
docker compose up --build
```
