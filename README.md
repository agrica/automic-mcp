# automic-mcp

Serveur MCP (stdio) pour l'API REST v1 d'**Automic Automation 24.4**. Lecture seule par défaut.

## Tools

| Tool | Accès | Endpoint |
|---|---|---|
| `automic_ping` | lecture | `GET /ping` |
| `automic_system_info` | lecture | `GET /{client}/system/info` |
| `automic_search_objects` | lecture | `POST /{client}/search` |
| `automic_get_object` | lecture | `GET /{client}/objects/{name}` (types autorisés seulement, voir plus bas) |
| `automic_get_object_usage` | lecture | `GET /{client}/objects/{name}/usage` |
| `automic_list_executions` | lecture | `GET /{client}/executions` (première page) |
| `automic_get_execution` | lecture | `GET /{client}/executions/{run_id}` |
| `automic_list_execution_children` | lecture | `GET /{client}/executions/{run_id}/children` (première page) |
| `automic_get_execution_report` | lecture | `GET /{client}/executions/{run_id}/reports[/{type}]` |
| `automic_execute_object` | **écriture** | `POST /{client}/executions` |
| `automic_change_execution_status` | **écriture** | `POST /{client}/executions/{run_id}/status` (annulation jamais récursive, ou redémarrage) |

Les tools d'écriture n'existent que si `AUTOMIC_ENABLE_WRITE=true`, et seulement pour les actions qui ont au moins un objet revu (voir « Écritures : responsabilités »).

`automic_get_object` n'exporte que les types CALE, DOCU, EVNT, JOBF, JOBG, JOBI, JOBP, JOBS, JSCH, PRPT, SCRI et VARA. Tout autre type (dont LOGIN, CONN, CERT), un type absent, ou une réponse dont la clé et le type déclaré divergent, est refusé.

## Configuration

| Variable | Obligatoire | Défaut | Description |
|---|---|---|---|
| `AUTOMIC_BASE_URL` | oui | | `https://<hôte>:<port>/ae/api/v1`, sans identifiants, sans query, sans fragment |
| `AUTOMIC_CLIENT` | oui | | 1 à 9999. Le client 0 (système) est refusé |
| `AUTOMIC_USER` / `AUTOMIC_DEPARTMENT` | oui | | sans `/`, `:` ni espace |
| `AUTOMIC_PASSWORD` | oui | | utilisé tel quel. Ne jamais le versionner |
| `AUTOMIC_ALLOW_INSECURE_HTTP` | non | `false` | `true` pour accepter une URL `http://` : les identifiants circulent alors en clair |
| `AUTOMIC_ENABLE_WRITE` | non | `false` | active les tools d'écriture des actions qui ont des objets revus |
| `AUTOMIC_EXECUTE_ALLOWLIST` | au moins une des trois listes si écriture | | objets revus pour le **lancement** : `NOM@sha256:<64 hex>`, séparés par des virgules ; noms exacts, sans joker |
| `AUTOMIC_CANCEL_ALLOWLIST` | idem | | objets revus pour l'**annulation**, même format |
| `AUTOMIC_RESTART_ALLOWLIST` | idem | | objets revus pour le **redémarrage**, même format |
| `AUTOMIC_TIMEOUT_MS` | non | `30000` | timeout total d'une requête, lecture du corps comprise (1000 à 300000) |
| `AUTOMIC_MAX_RESPONSE_BYTES` | non | `5242880` | taille max d'une réponse HTTP, lecture interrompue au-delà |
| `AUTOMIC_REPORT_MAX_CHARS` | non | `20000` | taille max du **contenu** d'un rapport renvoyé, mesurée après masquage (on garde la fin) |
| `AUTOMIC_MAX_OUTPUT_CHARS` | non | `100000` | budget d'un résultat de tool (10000 à 2000000). Au-delà : erreur, jamais de JSON tronqué. Doit valoir au moins `AUTOMIC_REPORT_MAX_CHARS + 5000` |

Seules les valeurs `true` et `false` sont acceptées pour les booléens. Toute autre valeur est une erreur de configuration. L'ancienne variable `AUTOMIC_WRITE_ALLOWLIST` (motifs avec joker) est refusée au démarrage.

## Ce que le serveur garantit, et ce qu'il ne garantit pas

- **Secrets connus** (mot de passe configuré et jetons dérivés) : masqués partout, valeurs, nombres **et** noms de propriétés, quelle que soit leur longueur, avant toute troncature. Un nombre qui contient un secret devient `***` (avec un mot de passe numérique, certains RunID seraient masqués : préférer un mot de passe non numérique). Un contrôle final retient toute sortie où l'un d'eux subsisterait.
- **Écriture confirmée, sortie retenue** : si les détails d'une écriture réussie ne peuvent pas être renvoyés (secret, budget, rendu), le résultat reste un **succès** avec `details_withheld`. L'action a eu lieu : ne pas la relancer, lire l'exécution avec les tools de lecture ou dans l'AWI. Si stderr devient indisponible, le diagnostic est perdu mais le résultat et son classement ne changent pas.
- **Autres secrets** : des heuristiques masquent les formes courantes (`password=…` y compris dans un identifiant comme `DB_PASSWORD=…`, `Bearer …`, identifiants dans une URL, clés et lignes de VARA « secrètes »). Elles ne promettent **pas** une confidentialité universelle : un secret inconnu sans forme reconnaissable peut apparaître dans un script ou un rapport.
- **Rapports** : `tail_reached` et `complete` décrivent le rapport tel qu'il a été lu pendant l'appel. L'API ne fournit pas d'instantané : un rapport d'exécution active peut encore s'allonger. `totals_seen` et `total_trend` montrent si le rapport a bougé pendant la lecture. Les pages sont choisies par leur numéro, quelle que soit la façon dont le serveur interprète `start_at` (`start_at_semantics` l'indique quand la lecture commence au-delà de la page 1). Si le serveur refuse `start_at=0` par un 400, la lecture repart de 1 (`start_at_zero: "refused"`) ; toute autre erreur est affichée telle quelle.
- **Exécutions désactivées** : Automic les masque par défaut. `includeDeactivated: true` les inclut ; c'est nécessaire pour retrouver une tâche courte déjà terminée.
- **Listes d'exécutions et d'enfants** : première page seulement. Si `may_have_more` vaut `true`, réduire la fenêtre de temps (`timeFrom`, `timeTo`) ou ajouter des filtres. Aucun curseur de continuation n'est fourni tant que la règle de pagination n'est pas démontrée.
- **Recherche** : `next_start_at` suit l'index documenté. Les résultats peuvent se décaler entre deux appels.

## Environnements

| Système AE | Client | Environnement |
|---|---|---|
| Hors production (connexion AWI `AE_REC`) | 400 / 300 / 200 | Dev / Qualification / Recette |
| Production | 100 | Production (hors périmètre de ce serveur) |

Il faut déclarer un serveur MCP par client. L'URL REST du système hors production est communiquée par l'équipe Automic.

## Proxy

Sous Node 24, `fetch` n'utilise les variables `HTTP_PROXY`, `HTTPS_PROXY` et `NO_PROXY` que si `NODE_USE_ENV_PROXY=1`, ou avec l'option `--use-env-proxy` (Node 24.5.0 et plus, donc toute version prise en charge ; voir la doc Node « Enterprise network configuration »). Si le poste active ce mode, il faut ajouter l'hôte Automic à `NO_PROXY` (ex. `NO_PROXY=.corp.example`), car le proxy d'entreprise ne résout pas les noms internes.

## Protocole MCP

Packages du SDK officiel : `@modelcontextprotocol/server` 2.3.1. Le serveur est lancé par `serveStdio`, qui sert, selon ce que demande l'hôte, la révision **2025-11-25** (ouverture par `initialize`) ou **2026-07-28** (annonce `server/discover`). Les tools et leurs résultats sont les mêmes dans les deux cas. La révision réellement négociée par Claude Code n'est pas encore relevée (recette).

## Utilisation avec Claude Code

Prérequis : **Node.js 24.x, 24.11.0 ou plus** (de préférence la dernière 24.x, pour ses correctifs de sécurité). `npm ci` refuse toute version hors de la branche 24 (`engine-strict`).

```bash
npm ci && npm run build
```

`.mcp.json` (le mot de passe est lu depuis l'environnement de la session) :

```json
{
  "mcpServers": {
    "automic-dev": {
      "command": "node",
      "args": ["<chemin>/automic-mcp/dist/index.js"],
      "env": {
        "AUTOMIC_BASE_URL": "${AUTOMIC_BASE_URL}",
        "AUTOMIC_CLIENT": "400",
        "AUTOMIC_USER": "${AUTOMIC_USER}",
        "AUTOMIC_DEPARTMENT": "${AUTOMIC_DEPARTMENT}",
        "AUTOMIC_PASSWORD": "${AUTOMIC_PASSWORD}"
      }
    }
  }
}
```

## Écritures : responsabilités

Les annotations MCP (`destructiveHint`) ne sont **pas** un contrôle d'autorisation. L'écriture n'est sûre que si les trois verrous suivants sont en place :

1. Un compte Automic technique dédié, avec le minimum de droits (lecture, plus exécution, annulation et redémarrage limités aux objets revus du bac à sable).
2. Des **objets revus, une liste par action** (`AUTOMIC_EXECUTE_ALLOWLIST`, `AUTOMIC_CANCEL_ALLOWLIST`, `AUTOMIC_RESTART_ALLOWLIST`), chaque entrée épinglée par l'empreinte de la définition revue.
3. Une approbation humaine dans l'hôte. Dans Claude Code :

```json
{ "permissions": { "ask": ["mcp__automic-dev__automic_execute_object", "mcp__automic-dev__automic_change_execution_status"] } }
```

Ces tools ne doivent jamais figurer dans `permissions.allow`, ni être utilisés dans un mode qui contourne les approbations.

**Ajouter un objet revu.** Le type ne suffit pas : un SCRI peut activer d'autres objets (`ACTIVATE_UC_OBJECT`) et les réactiver à son redémarrage, un JOBS peut appeler l'API Automic. Pour chaque action :

1. L'équipe Automic revoit la définition : aucun autre objet activé, aucun effet métier, annulation ou redémarrage sans conséquence à tout moment. Sinon, l'objet n'entre dans aucune liste.
2. Lire l'objet en lecture seule avec `automic_get_object` et relever `fingerprint` (`sha256:…`).
3. Ajouter `NOM@sha256:…` à la liste de **chaque** action revue, puis redémarrer le serveur.

À chaque écriture, le serveur relit la définition et compare son empreinte : si l'objet a changé depuis la revue, l'écriture est refusée (`definition_changed`) jusqu'à une nouvelle revue. Le type reste aussi filtré (JOBS, JOBF, SCRI seulement : jamais un workflow ni un plan). L'annulation n'est **jamais récursive**. Ces contrôles ne sont pas atomiques : une modification entre la relecture et l'envoi n'est pas détectée.

Une exécution dont l'alias diffère du nom de son objet est refusée pour l'annulation et le redémarrage : la revue épingle des noms d'objets, pas des alias. La revue ne couvre que la définition : les valeurs d'entrée (`inputs`), la file (`queue`) et l'alias passés au lancement ne sont pas épinglés, et doivent être jugés au moment de l'approbation dans l'hôte.

Une réponse `OUTCOME UNKNOWN` ne doit **jamais** être relancée telle quelle. Le message donne la lecture de rapprochement propre à l'action, avec ses arguments exacts (exécutions désactivées comprises, fenêtre d'activation bornée). Cette lecture ne fournit que des **candidats**, jamais une preuve :

| Action | Lecture | Ce qu'elle ne prouve pas |
|---|---|---|
| Lancement | `automic_list_executions` sur le nom, fenêtre d'activation, `includeDeactivated: true` | qu'un candidat vient de **cette** requête (un autre lancement peut coïncider) |
| Annulation | `automic_get_execution` | qu'un statut terminé vient de **cette** requête ; seul un statut encore actif dit quelque chose (pas encore appliqué) |
| Redémarrage | `automic_list_executions` avec `referenceRunId`, fenêtre d'activation, `includeDeactivated: true` | qu'un candidat vient de **cette** requête : `reference_run_id` désigne l'exécution d'origine, un autre opérateur a pu la redémarrer |

L'issue reste inconnue jusqu'à une vérification humaine dans l'AWI, avant toute nouvelle tentative.

Chaque phase d'une écriture (`attempt`, `blocked`, `precheck_failed`, `sent`, `result`) produit une ligne d'audit JSON sur stderr (`event: "automic_write"`). L'événement est masqué avant sérialisation, ses champs libres sont bornés, et il ne contient ni secret ni valeur d'entrée. Si le journal ne peut pas être écrit, l'action garde son résultat et le signale (`audit_logged: false`).

## Développement

```bash
npm test               # tests unitaires (sans réseau)
npm run test:coverage  # avec seuils de couverture
npm run test:e2e       # build + binaire réel via stdio contre un faux Automic local (dont les deux ères MCP)
npm run typecheck      # TypeScript 7
npm run lint           # Biome
npm run lint:workflows # YAML strict (actionlint s'exécute en CI)
```

### Release

Pousser un tag `vX.Y.Z` déclenche `.github/workflows/release.yml` : le tag doit égaler la version de `package.json` et de `src/version.ts`, puis lint, typecheck, tests, e2e, et une release GitHub avec notes générées et l'archive `npm pack` en pièce jointe. Un tag avec suffixe (`v1.0.0-rc.1`) produit une pré-release.

```bash
npm version patch --no-git-tag-version   # met à jour package.json et package-lock.json
# reporter la même version dans src/version.ts, puis :
git commit -am "chore: release vX.Y.Z"
git tag vX.Y.Z
git push origin main vX.Y.Z
```

Référence d'API : `docs/reference/ae-rest-24.4.json` (provenance dans `docs/reference/PROVENANCE.md`).
