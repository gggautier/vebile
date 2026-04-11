# Vébile

Web app mobile-first affichant en temps réel les stations Vélib les plus proches de votre position GPS.

## Stack

- HTML / CSS / JavaScript vanilla
- API : [Vélib Open Data Paris](https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/velib-disponibilite-en-temps-reel/records) (sans clé)
- Déploiement : GitHub Pages

## Fonctionnalités

- Géolocalisation GPS et tri par distance (Haversine)
- Boussole dynamique : la flèche pointe vers chaque station
- Badges : vélos mécaniques, électriques, emplacements libres
- Tap sur la flèche → itinéraire à pied Google Maps
- Pagination +5 stations
- Skeleton loading, gestion erreur réseau, géolocalisation refusée
- Refresh = nouvel appel API + recalcul distances

## Structure

```
vebile/
├── index.html
├── style.css
├── app.js
├── assets/
│   └── logo.svg
└── README.md
```

## Déploiement GitHub Pages

```bash
# 1. Initialiser le repo local
git init
git add .
git commit -m "feat: initial Vébile app"

# 2. Créer le repo sur GitHub (remplace TON_USERNAME)
gh repo create TON_USERNAME/vebile --public --source=. --remote=origin --push

# OU sans GitHub CLI :
git remote add origin https://github.com/TON_USERNAME/vebile.git
git branch -M main
git push -u origin main

# 3. Activer GitHub Pages
gh api repos/TON_USERNAME/vebile/pages \
  -X POST \
  -f source[branch]=main \
  -f source[path]=/

# OU dans GitHub : Settings → Pages → Source: main / root → Save
```

L'app sera disponible sur `https://TON_USERNAME.github.io/vebile/`
