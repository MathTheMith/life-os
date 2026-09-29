# Life OS

App perso : suivi de budget (import CSV bancaire), et chat avec Claude. PWA installable sur mobile.

## En production

**https://46.224.119.108.nip.io** — déployé sur le serveur `46.224.119.108`, HTTPS via Let's Encrypt (nip.io fait pointer ce nom de domaine vers l'IP du serveur sans avoir besoin d'acheter un vrai domaine — renouvellement du certificat automatique).

Architecture sur le serveur :
- `claude-service` (conteneur Docker, **aucun port publié** — injoignable depuis l'extérieur ou même depuis l'hôte, uniquement depuis `backend` via le réseau Docker interne). C'est le seul endroit qui détient `ANTHROPIC_API_KEY`.
- `backend` (conteneur Docker, lié à `127.0.0.1:4100` seulement — pas exposé directement à internet).
- `frontend` — fichiers statiques buildés, servis directement par nginx depuis `/var/www/life-os` (pas de conteneur, juste un dossier).
- nginx (sur l'hôte) fait office de reverse proxy + terminaison TLS : sert le frontend, route `/api/*` vers le backend.

### Mettre ta vraie clé API Anthropic

Le service ne fonctionnera pas tant que la vraie clé n'est pas en place (un placeholder y est actuellement). Fais-le toi-même en SSH plutôt que de me la donner en clair dans le chat :

```sh
ssh root@46.224.119.108
sed -i 's/^ANTHROPIC_API_KEY=.*/ANTHROPIC_API_KEY=sk-ant-ta-vraie-cle/' /root/life-os/.env
cd /root/life-os && docker compose up -d --force-recreate claude-service
```

### Redéployer après une modification du code

Depuis ta machine :

```sh
rsync -az --exclude 'node_modules' --exclude 'dist' --exclude '.env' --exclude 'data.sqlite*' \
  "life-os/" root@46.224.119.108:/root/life-os/
```

Puis sur le serveur :

```sh
cd /root/life-os
docker compose build && docker compose up -d          # backend + claude-service
docker build -t life-os-frontend-build ./frontend      # frontend
docker create --name tmp-extract life-os-frontend-build
rm -rf /var/www/life-os/*
docker cp tmp-extract:/app/dist/. /var/www/life-os/
docker rm tmp-extract
chown -R www-data:www-data /var/www/life-os
```

### Sécurité — points à connaître

- Le mot de passe root a été utilisé une seule fois pour installer une clé SSH ; l'accès se fait maintenant par clé. **Pense à changer ce mot de passe root** puisqu'il a été partagé en clair dans une conversation.
- `claude-service` n'a aucun port publié sur l'hôte — même en cas de mauvaise config ailleurs sur le serveur, il reste injoignable de l'extérieur. Seul `backend` peut lui parler, via un secret partagé (`INTERNAL_SECRET`, généré aléatoirement, stocké dans `/root/life-os/.env`).
- Le serveur héberge d'autres projets (site tennis, code-server, un bot Discord, replayto.com via un tunnel Cloudflare) — je n'ai touché à aucun d'entre eux. Aucun pare-feu (`ufw`) n'est actif sur ce serveur ; je ne l'ai pas activé pour ne pas risquer de casser ces autres services sans une revue complète de tous les ports nécessaires.

## Structure

- `backend/` — serveur Express (TypeScript). Garde la clé API Claude côté serveur, gère l'import CSV, la catégorisation et le budget dans une base SQLite locale (`backend/data.sqlite`).
- `frontend/` — PWA React (Vite). Trois onglets : Budget, Import, Chat.

## Démarrage

### 1. Backend

```sh
cd backend
npm install
cp .env.example .env
# édite .env et mets ta clé : ANTHROPIC_API_KEY=sk-ant-...
npm run dev
```

Écoute sur `http://localhost:3001`.

### 2. Frontend

```sh
cd frontend
npm install
npm run dev
```

Écoute sur `http://localhost:5173`, avec un proxy vers le backend pour `/api/*`.

Sur ton téléphone, une fois que tu veux y accéder en dehors de ton PC : lance le backend + le build du frontend (`npm run build` puis sers `frontend/dist`) sur ta machine, et utilise Tailscale (ou équivalent) pour y accéder depuis ton téléphone sans exposer quoi que ce soit publiquement. Ouvre l'URL dans Chrome/Safari mobile puis "Ajouter à l'écran d'accueil" pour l'installer comme une app.

## Coût du chat

Le endpoint `/api/chat` utilise `claude-opus-5` par défaut. Pour un usage perso léger (quelques messages par jour), le coût est de l'ordre de quelques centimes par mois. Si tu veux réduire encore plus, passe `model: "claude-haiku-4-5"` dans le corps de la requête depuis le frontend (`src/api.ts` → `sendChat`), c'est le modèle le moins cher pour du chat simple.

## Catégorisation automatique

Les règles de catégorisation (mot-clé → catégorie) sont dans `backend/src/db.ts` (`defaultRules`). Ajoute-en au fur et à mesure que tu importes tes relevés — par exemple pour reconnaître tes dépenses karting/simracing spécifiques.

## Prochaines étapes possibles

- Module de suivi motorsport (chronos, classements, écarts par course) réutilisant la structure de ton plan.
- Authentification si tu héberges ça ailleurs que sur ta machine perso.
- Export/sauvegarde de la base SQLite.
