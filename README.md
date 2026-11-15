<p align="center">
  <img src="public/orar-icon.svg" width="96" height="96" alt="Logo ORar" />
</p>

<h1 align="center">ORar</h1>

<p align="center">
  <strong>Gestionnaire d'archives moderne, rapide et chiffré — avec format signature <code>.orar</code></strong>
</p>

<p align="center">
  <a href="https://github.com/Logan-FORNIER/ORar/releases"><img src="https://img.shields.io/github/v/release/Logan-FORNIER/ORar?include_prereleases&style=flat-square&color=f59e0b" alt="Release" /></a>
  <a href="https://github.com/Logan-FORNIER/ORar/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/Logan-FORNIER/ORar/release.yml?style=flat-square&label=Release%20CI" alt="Build & Release" /></a>
  <img src="https://img.shields.io/badge/Tauri-v2-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri v2" />
  <img src="https://img.shields.io/badge/Rust-Backend-000000?style=flat-square&logo=rust&logoColor=white" alt="Rust" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React 19" />
  <img src="https://img.shields.io/badge/Plateforme-Windows-0078D6?style=flat-square" alt="Windows" />
</p>

---

## Aperçu

**ORar** est une alternative moderne à WinRAR / 7-Zip conçue avec **Tauri v2**, **Rust** et **React 19 + TypeScript**.  
Il combine une interface sombre/claire réactive, la gestion complète des formats d'archives courants et un **format signature `.orar`** intégrant compression Zlib / Store, chiffrement **AES-256-GCM + PBKDF2-HMAC-SHA256** et **déduplication inter-fichiers** native.

---

## Fonctionnalités principales

### Format signature `.orar`
- **Compression flexible** : choix entre compression haute densité **Zlib** (`Compression::default()` / niveau 1..9) ou **Store** (sans compression) côté `.orar`, plus Deflate/Zstandard/LZMA selon le format choisi.
- **Chiffrement fort** : protection optionnelle par mot de passe via **AES-256-GCM** et dérivation de clé **PBKDF2-HMAC-SHA256** (100 000 itérations, protégeant les données et optionnellement les noms de fichiers).
- **Déduplication inter-fichiers native** : les fichiers strictement identiques `(size, crc32, sha256)` ne sont stockés physiquement qu'une seule fois dans l'archive, avec indicateur `⚡` par entrée et suivi des octets économisés.
- **Intégrité vérifiable** : somme **CRC32** pour chaque entrée et **manifeste global SHA-256**.

### Support multi-formats
- **Création et extraction** : `.orar`, `.zip`, `.tar`, `.tar.gz` (`.tgz`), `.7z`, `.tar.zst`, `.tar.xz`.
- **Ouverture et extraction** : `.rar`, `.bz2`, `.xz`, `.zst` (et détection automatique multi-volumes).

### Édition directe & Notes Markdown
- **Live Edit & Save (`Ctrl+S`)** : modifiez les fichiers texte et code source directement dans le volet d'aperçu sans extraire l'archive (`.orar` et `.zip`).
- **Manipulation sur place** : création de nouveaux fichiers texte/Markdown, création de dossiers, ajout par glisser-déposer ou sélecteur, renommage (`F2`) et suppression (`Suppr`).
- **Bannière Note Markdown** : affichez et éditez une note Markdown (`#`, `##`, `###`, listes `-`/`*`, `**gras**`, `` `code` ``) intégrée directement aux métadonnées de l'archive (`comment`).

### Smart Dev Ignore
- Activez le mode **Smart Dev Ignore** lors de la création d'archive pour exclure automatiquement les dossiers et fichiers temporaires lourds : `node_modules`, `target`, `.git`, `dist`, `__pycache__`, `.venv`, `*.tmp`, `*.bak`, `*.swp`, `*.log`, ainsi que vos propres motifs d'exclusion.

### Centre d’Outils Avancé
Accessible depuis la barre d'outils ou par raccourcis clavier :
- **Recherche plein texte (`Alt+F`)** : recherche instantanée dans les chemins et le contenu texte des fichiers archivés.
- **Analyse visuelle d'espace (`Alt+T`)** : cartes treemap par dossier/extension et bilan des économies de déduplication `.orar`.
- **Comparateur d'archives (`Diff v1 vs v2`)** : compare deux archives par chemin, taille et CRC32 (`ajoutés`, `supprimés`, `modifiés`, `identiques`).
- **Profils de sauvegarde 1-clic & Batch Studio** : sauvegardez des profils locaux horodatés en 1 clic et compressez/extrayez plusieurs dossiers ou archives en lot.
- **Stego-ORar (`.png`) & Windows SFX (`.cmd`)** : dissimulez une archive complète à la fin d'une image PNG valide (signature `ORARSTEG` + CRC32) ou générez un auto-extractible Windows `.cmd` PowerShell autonome.
- **Convertisseur, Multi-volumes, Réparation (`Alt+R`) & Benchmark (`Alt+B`)** : conversion entre formats, découpage/fusion `.part001`, reconstruction d'archives endommagées et banc d'essai Zstd / Deflate / Store.

### Auto-Updater & Centre de Mise à Jour intégré
- **Vérification automatique au démarrage** : ORar interroge GitHub Releases (`Logan-FORNIER/ORar`) au lancement pour comparer la version locale avec le dernier tag publié (`v*`).
- **Badge interactif & Téléchargement 1-clic** : cliquez sur la pastille de version (`v0.1.0` / `MAJ vX.Y.Z`) dans la barre supérieure pour consulter les notes de version, ouvrir GitHub Releases ou télécharger et lancer directement le nouvel installeur Windows.

---

## Raccourcis clavier

| Raccourci | Action |
| :--- | :--- |
| `Ctrl + O` | Ouvrir une archive |
| `Ctrl + N` | Créer une nouvelle archive |
| `Ctrl + E` | Extraire l'archive courante |
| `Ctrl + F` | Filtrer les fichiers dans l'archive |
| `Ctrl + S` | Sauvegarder l'édition à chaud dans l'aperçu |
| `Alt + T` | Ouvrir l'Analyse visuelle d'espace (Centre d'outils) |
| `Alt + F` | Ouvrir la Recherche plein texte |
| `Alt + B` | Ouvrir le Benchmark multi-algorithmes |
| `Alt + R` | Ouvrir l'outil de Réparation d'archive |
| `F2` | Renommer l'entrée sélectionnée (`.orar` / `.zip`) |
| `Suppr` | Supprimer la sélection (`.orar` / `.zip`) |
| `Backspace` | Remonter au dossier parent dans l'archive |

---

## Développement local

### Prérequis
- **Node.js** `20+` (recommandé `22`)
- **Rust** (`rustup` / `cargo` stable) et prérequis système **Tauri v2** (WebView2 sous Windows)

### Commandes utiles

```powershell
# Installer les dépendances JS
npm install

# Lancer l'application desktop en mode développement
npm run tauri dev

# Vérifier le typage TypeScript
npm run typecheck

# Exécuter les tests unitaires Rust
cargo test --manifest-path src-tauri/Cargo.toml

# Compiler le frontend + installeur Windows NSIS
npm run build:installer
```

---

## Système de Tags & Releases automatiques

Le projet intègre un script de versioning ([`scripts/release-tag.mjs`](scripts/release-tag.mjs)) et un workflow GitHub Actions ([`.github/workflows/release.yml`](.github/workflows/release.yml)) :

1. **Synchronisation automatique** de la version dans `package.json`, `src-tauri/tauri.conf.json` et `src-tauri/Cargo.toml`.
2. **Création du commit et du tag Git annoté** `vX.Y.Z`.
3. **Build & Publication automatique sur GitHub Releases** à chaque push d'un tag `v*`.

### Commandes de release

```powershell
# Créer un tag sur la version actuelle (ex: v0.1.0)
npm run tag

# Fixer une version explicite
npm run tag -- 0.2.0

# Incrémenter automatiquement et push vers GitHub (patch / minor / major)
npm run tag -- patch --push
npm run tag -- minor --push
npm run tag -- major --push

# Raccourci équivalent avec --push activé
npm run release -- patch
```

Une fois le tag `v*` poussé sur GitHub (`git push origin v0.1.0`), GitHub Actions compile l'installeur Windows via Tauri et publie la release correspondante dans l'onglet **Releases** du dépôt.
