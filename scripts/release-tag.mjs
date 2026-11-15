#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const PACKAGE_JSON_PATH = path.join(ROOT_DIR, 'package.json');
const TAURI_CONF_PATH = path.join(ROOT_DIR, 'src-tauri', 'tauri.conf.json');
const CARGO_TOML_PATH = path.join(ROOT_DIR, 'src-tauri', 'Cargo.toml');

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function printHelp() {
  console.log(`
ORar — Gestionnaire de version, tag Git et release

Usage:
  npm run tag -- [version|patch|minor|major] [--push] [--dry-run]
  npm run release -- [version|patch|minor|major]

Options:
  <version>   Version explicite (ex: 0.2.0 ou v0.2.0) ou incrément (patch, minor, major).
              Sans argument, utilise la version actuelle de package.json.
  --push      Pousse la branche courante et le tag vX.Y.Z vers origin.
  --dry-run   Affiche les opérations sans modifier les fichiers ni créer de tag.
  -h, --help  Affiche cette aide.

Exemples:
  npm run tag                   # Crée le tag annoté pour la version actuelle (ex: v0.1.0)
  npm run tag -- patch          # Passe 0.1.0 -> 0.1.1 et crée le tag v0.1.1
  npm run tag -- 0.2.0 --push   # Passe à 0.2.0, commit, crée v0.2.0 et pousse sur GitHub
  npm run release -- minor      # Passe 0.1.0 -> 0.2.0, tag et pousse sur GitHub
`);
}

function runGit(args, options = {}) {
  return execFileSync('git', args, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
}

function tryGit(args) {
  try {
    return runGit(args, { capture: true }).trim();
  } catch {
    return null;
  }
}

function resolveTargetVersion(currentVersion, spec) {
  const currentMatch = SEMVER_RE.exec(currentVersion.trim());
  if (!currentMatch) {
    throw new Error(`Version actuelle invalide dans package.json : "${currentVersion}"`);
  }

  let major = Number(currentMatch[1]);
  let minor = Number(currentMatch[2]);
  let patch = Number(currentMatch[3]);

  if (!spec) {
    return `${major}.${minor}.${patch}${currentMatch[4] ? `-${currentMatch[4]}` : ''}`;
  }

  if (spec === 'patch') {
    patch += 1;
    return `${major}.${minor}.${patch}`;
  }
  if (spec === 'minor') {
    minor += 1;
    patch = 0;
    return `${major}.${minor}.${patch}`;
  }
  if (spec === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
    return `${major}.${minor}.${patch}`;
  }

  const explicitMatch = SEMVER_RE.exec(spec.trim());
  if (!explicitMatch) {
    throw new Error(
      `Argument de version invalide : "${spec}". Utilisez X.Y.Z, vX.Y.Z, patch, minor ou major.`
    );
  }
  return `${explicitMatch[1]}.${explicitMatch[2]}.${explicitMatch[3]}${
    explicitMatch[4] ? `-${explicitMatch[4]}` : ''
  }`;
}

function updateJsonVersion(filePath, nextVersion, dryRun) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const changed = parsed.version !== nextVersion;
  if (changed && !dryRun) {
    parsed.version = nextVersion;
    fs.writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  }
  return changed;
}

function updateCargoVersion(filePath, nextVersion, dryRun) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let inPackage = false;
  let updated = false;
  let changed = false;

  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inPackage = trimmed === '[package]';
      return line;
    }
    if (inPackage && !updated && /^version\s*=\s*"[^"]*"/.test(trimmed)) {
      updated = true;
      const nextLine = line.replace(/^(\s*version\s*=\s*)"[^"]*"/, `$1"${nextVersion}"`);
      if (nextLine !== line) changed = true;
      return nextLine;
    }
    return line;
  });

  if (!updated) {
    throw new Error(`Champ [package].version introuvable dans ${filePath}`);
  }
  if (changed && !dryRun) {
    fs.writeFileSync(filePath, out.join(eol), 'utf8');
  }
  return changed;
}

function main() {
  const args = process.argv.slice(2);
  let shouldPush = false;
  let dryRun = false;
  let versionSpec = null;

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      printHelp();
      return;
    }
    if (arg === '--push') {
      shouldPush = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Option inconnue : ${arg}`);
    }
    if (versionSpec !== null) {
      throw new Error(`Argument en trop : ${arg}`);
    }
    versionSpec = arg;
  }

  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  const currentVersion = pkg.version;
  const targetVersion = resolveTargetVersion(currentVersion, versionSpec);
  const tagName = `v${targetVersion}`;

  console.log(`Version actuelle : ${currentVersion}`);
  console.log(`Version cible    : ${targetVersion} (tag ${tagName})${dryRun ? ' [DRY-RUN]' : ''}`);

  const pkgChanged = updateJsonVersion(PACKAGE_JSON_PATH, targetVersion, dryRun);
  const tauriChanged = updateJsonVersion(TAURI_CONF_PATH, targetVersion, dryRun);
  const cargoChanged = updateCargoVersion(CARGO_TOML_PATH, targetVersion, dryRun);

  if (pkgChanged || tauriChanged || cargoChanged) {
    console.log(
      `${dryRun ? 'À mettre à jour' : 'Mis à jour'} :` +
        `${pkgChanged ? ' package.json' : ''}` +
        `${tauriChanged ? ' src-tauri/tauri.conf.json' : ''}` +
        `${cargoChanged ? ' src-tauri/Cargo.toml' : ''}`
    );
  } else {
    console.log('Tous les fichiers de version sont déjà synchronisés.');
  }

  const isGitRepo = tryGit(['rev-parse', '--is-inside-work-tree']) === 'true';
  if (!isGitRepo) {
    console.warn('Aucun dépôt Git détecté dans e:\\ORar : étape de tag Git ignorée.');
    return;
  }

  const hasHead = tryGit(['rev-parse', '--verify', 'HEAD']) !== null;
  if (!hasHead) {
    throw new Error(
      'Le dépôt Git ne contient aucun commit. Faites d’abord un commit initial (git add . && git commit -m "chore: initial commit").'
    );
  }

  const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
  const prevTag = tryGit(['describe', '--tags', '--abbrev=0']);
  const logRange = prevTag ? `${prevTag}..HEAD` : 'HEAD';
  const commitList = tryGit(['log', logRange, '--pretty=format:- %s (%h)', '-n', '30']);
  const tagMessage = commitList
    ? `ORar ${tagName}\n\nChangements :\n${commitList}`
    : `ORar ${tagName}`;

  if (dryRun) {
    if (pkgChanged || tauriChanged || cargoChanged) {
      console.log(`[dry-run] git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml`);
      console.log(`[dry-run] git commit -m "chore(release): ${tagName}"`);
    }
    console.log(`[dry-run] git tag -a ${tagName} -m "<changelog>" -f`);
    if (commitList) {
      console.log(`[dry-run] Notes de version détectées (${prevTag ? `depuis ${prevTag}` : 'initial'}):\n${commitList}`);
    }
    if (shouldPush) {
      console.log(`[dry-run] git push origin ${branch}`);
      console.log(`[dry-run] git push origin ${tagName} --force`);
    }
    return;
  }

  runGit(['add', 'package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml']);
  const stagedDiff = tryGit(['diff', '--cached', '--name-only']);
  if (stagedDiff) {
    runGit(['commit', '-m', `chore(release): ${tagName}`]);
  }

  runGit(['tag', '-a', tagName, '-m', tagMessage, '-f']);
  console.log(`Tag annoté créé : ${tagName}`);

  if (shouldPush) {
    console.log(`Push vers origin (${branch} + ${tagName})...`);
    runGit(['push', 'origin', branch]);
    runGit(['push', 'origin', tagName, '--force']);
    console.log(`Release déclenchée sur GitHub pour ${tagName}.`);
  } else {
    console.log(`\nPour pousser vers GitHub et déclencher le build Release :\n  git push origin ${branch} --follow-tags`);
  }
}

try {
  main();
} catch (err) {
  console.error(`Erreur : ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
