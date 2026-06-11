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

## Használat

- Filmek/sorozatok hozzáadása: Admin gomb -> Katalógus
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
