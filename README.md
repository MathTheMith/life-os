# Life OS

Assistant perso de Mathéo : brief du matin, agenda, veille stages et mails, journal du soir avec coach, budget synchronisé avec la banque, suivi karting. PWA installable sur Android, protégée par un mot de passe.

**Production : https://46.224.119.108.nip.io** (HTTPS Let's Encrypt, renouvellement automatique par certbot).

## Ce que fait l'app

L'app a 4 onglets, plus une page « Moi » derrière l'icône de profil :

- **Today** : brief de 9h (engagements du jour, question du jour), cartes « Prêt pour toi » (brouillons de candidature, relances), ligne budget.
- **Agenda** : événements et rappels. L'IA en ajoute depuis le chat, le journal et les mails. Les rappels arrivent en notification push.
- **Radar** : veille web (offres de stage, à 7h et 18h, Europe uniquement, hors UK) et tri des mails, en swipe (droite = intéressé, gauche = non, haut = urgent).
- **Chat** : conversation avec l'IA, qui a des outils sur toutes les données. Le bouton lune ouvre le chat du soir, qui devient une entrée de journal avec bilan du coach.
- **Moi** : profil (injecté en tête de chaque prompt), historique du journal, budget et import, pilotage (chronos karting), réglages (notifications, sources de veille).

## Architecture

```
nginx (hôte, TLS)
├── /          → /var/www/life-os         frontend React (Vite), fichiers statiques
├── /dl/       → /var/www/dl              APK du launcher Android
└── /api/      → 127.0.0.1:4100           backend (conteneur)

backend (Express + TypeScript, SQLite dans le volume life-os-data)
├── → claude-bridge  172.28.1.1:4200      service systemd sur l'hôte, appelle le CLI `claude` (Sonnet)
├── → Enable Banking                      synchro bancaire (PSD2)
└── → IMAP Gmail                          lecture seule, IDLE + passage toutes les 30 min
```

- **IA** : tous les appels passent par `backend/src/aiClient.ts` (`callAiService`), qui les envoie au pont Claude. L'ancien conteneur `ai-service` (Gemini) a été supprimé le 2026-10-10.
- **claude-bridge** (`claude-bridge/server.mjs`) tourne sur l'hôte car il a besoin du CLI `claude` déjà connecté. `/ask` sert au chat (session persistante, outils Read/Grep/Glob/WebSearch/WebFetch, 0,50 $ max par appel). `/complete` sert aux tâches de fond, sans outils. Installation : `claude-bridge/setup.sh`.
- **Tâches planifiées** dans le backend (heure de Paris) : veille 7h et 18h, actions avant le brief, brief 9h, rappel du soir 21h30 sans journal, rappels toutes les minutes.
- **Accès** : connexion par `APP_PASSWORD`. `LAUNCHER_TOKEN` donne au widget du launcher un accès limité à ses propres routes.

## Fichiers importants

- `backend/src/` : un fichier par fonction (`brief.ts`, `watch.ts`, `mail.ts`, `actions.ts`, `coach.ts`, `reminders.ts`, `push.ts`...) et les routes dans `routes/`.
- `frontend/src/` : PWA React.
- `.env` (non versionné) : `APP_PASSWORD`, `PUBLIC_URL`, `CRON_SECRET`, `MAIL_ACCOUNTS`, `ENABLEBANKING_APP_ID`, etc. La clé privée Enable Banking est dans `secrets/enablebanking/`.
- Les CV et lettres de `/root/motorsport_internship/candidatures` sont montés en lecture seule pour les brouillons de candidature.

## Déployer

```sh
/root/life-os/deploy.sh
```

Le script reconstruit et relance le backend, rebuild le frontend dans `/var/www/life-os`, garde l'ancien frontend dans `/root/life-os-backups/www-previous` et nettoie les images orphelines.

## Crons (crontab root)

| Heure | Tâche |
|---|---|
| xx:30 à 01h, 07h, 13h, 19h (Paris) | import bancaire `POST /api/banksync/import-all`. 4 fois par jour maximum à cause de la limite PSD2. Chaque import relit 10 jours en arrière. |
| 03:30 | `scripts/backup.sh` : snapshot SQLite + copie des uploads dans `/root/life-os-backups`, 14 jours gardés |
| 03:45 | `scripts/offsite-backup.sh` : chiffre le dernier snapshot avec `age` et le pousse sur le repo privé `MathTheMith/life-os-backups` (7 archives) |

Les logs sont dans `/var/log/life-os/`.

## Restaurer une sauvegarde

1. Cloner le repo privé `MathTheMith/life-os-backups`. Il contient les archives et la clé privée `backup-key.age`, protégée par une phrase de passe que seul Mathéo connaît. Les commandes exactes sont dans le README de ce repo (et dans `scripts/offsite-backup.sh`) :
   ```sh
   age -d -o key.txt backup-key.age                     # demande la phrase de passe
   age -d -i key.txt life-os-<date>.tar.age | tar -xf -
   rm key.txt
   ```
2. Arrêter le backend, remplacer `/app/data/data.sqlite` dans le volume, relancer.

## Dev local

```sh
cd backend && npm install && npm run dev     # http://localhost:3001
cd frontend && npm install && npm run dev    # http://localhost:5173, proxy /api vers le backend
```
