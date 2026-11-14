# Mod_wiki – Prix moyen sur les cartes WikiMasters

Script utilisateur (« userscript ») qui affiche le **prix de vente moyen du marché** directement sur chaque carte de ta collection sur [wiki-masters.com](https://www.wiki-masters.com/collection), sans avoir à ouvrir la carte puis « Mettre aux enchères ».

Le prix apparaît dans une pastille `Ⓦ 39` en bas à gauche de l'image de chaque carte :

- `Ⓦ 39` : prix moyen pour la rareté de ta carte
- `Ⓦ –` : aucune vente récente pour cette rareté
- `Ⓦ …` : chargement en cours
- `Ⓦ ?` : erreur de chargement (réessaie en rechargeant la page)

## Option 1 : l'application Android « WikiMasters Prix » (recommandé)

Une petite application qui ouvre WikiMasters (directement sur ta collection) avec le prix moyen déjà affiché sur les cartes. Rien d'autre à installer.

**Installer l'APK :**

1. Récupère `app-release.apk` :
   - onglet **Actions** du dépôt GitHub → dernière exécution « Compiler l'APK » → **Artifacts** → `WikiMastersPrix-apk` (fichier zip contenant l'APK) ;
   - ou compile-le toi-même (voir plus bas).
2. Ouvre le fichier sur ton téléphone. Android demande d'autoriser l'installation d'applications depuis cette source (Chrome, Fichiers…) : accepte.
3. Lance **WikiMasters Prix** et connecte-toi une première fois (la vérification Cloudflare fonctionne normalement). La session est conservée ensuite.

**Comportement :**

- les liens du site restent dans l'application ; les liens externes (Wikipédia…) s'ouvrent dans ton navigateur ;
- bouton retour = page précédente du site ;
- une nouvelle version s'installe par-dessus l'ancienne sans perdre ta connexion (signature fixe dans `android/app/signature.keystore`, volontairement non secrète).
- Limite : les notifications push du site ne passent pas par l'application (garde la version navigateur/PWA si tu en as besoin).

**Compiler soi-même :** JDK 17+ et SDK Android (plateforme 35), puis :

```bash
cd android
./gradlew assembleRelease
# -> android/app/build/outputs/apk/release/app-release.apk
```

Le script injecté est copié automatiquement depuis `wiki-masters-prix-moyen.user.js` : une seule source à modifier.

## Option 2 : userscript dans Firefox

Chrome pour Android n'accepte pas les extensions. Il faut un navigateur qui les accepte :

1. Installe **Firefox** depuis le Play Store.
2. Dans Firefox : menu ⋮ → **Extensions** → installe **Tampermonkey** (ou Violentmonkey).
3. Ouvre le fichier [`wiki-masters-prix-moyen.user.js`](wiki-masters-prix-moyen.user.js) sur GitHub, bouton **Raw** :
   Tampermonkey propose directement de l'installer.
   *Si le dépôt est privé* : dans Tampermonkey → **Créer un nouveau script**, efface le contenu, colle celui du fichier, enregistre.
4. Va sur wiki-masters.com dans Firefox, connecte-toi, ouvre ta collection.

## Fonctionnement

- Le script lit la liste des cartes que le site charge déjà (`/api/my-collection`) pour connaître l'identifiant de chaque carte affichée.
- Pour chaque carte **visible à l'écran**, il interroge la même source que la fenêtre « Mettre aux enchères » :
  `/api/marketplace/cards/<id>/sales?scope=summary`, puis garde la moyenne correspondant à la rareté de la carte.
- Requêtes limitées (2 en parallèle, pause de 250 ms) pour ne pas surcharger le site.
- Les prix sont gardés en mémoire **7 jours** ; recharger la page ne refait pas les requêtes.
- **Actualisation de fond** : tant que le site est ouvert (n'importe quelle page, sans faire défiler), le script parcourt toute la collection et récupère les prix manquants ou de plus de 7 jours, **1 carte toutes les 2 secondes**. Une petite pastille « ⟳ Prix 1 234 / 8 700 » en bas de l'écran indique la progression ; elle disparaît quand tout est à jour.
  - Les cartes affichées à l'écran restent prioritaires.
  - La progression est conservée : si tu fermes l'application, elle reprend où elle en était à la prochaine ouverture.
  - La liste des cartes est relue une fois par jour (pour inclure les nouvelles).
  - En cas d'erreur ou de « trop de requêtes », elle ralentit automatiquement (jusqu'à 5 min de pause) ; si tu es déconnecté, elle s'arrête.

Le script ne fait que lire : il n'achète, ne vend ni ne modifie rien sur ton compte. Il ne contient et ne transmet aucun identifiant ; il utilise simplement ta session déjà ouverte sur le site.

## Réglages

En haut du script :

| Constante | Défaut | Rôle |
|---|---|---|
| `CACHE_TTL_MS` | 7 jours | Durée de conservation des prix |
| `BG_ENABLED` | `true` | Active l'actualisation de fond |
| `BG_DELAY_MS` | 2000 | Pause entre deux requêtes de l'actualisation de fond |
| `MAX_PARALLEL` | 2 | Requêtes simultanées max |
| `DELAY_MS` | 250 | Pause entre deux requêtes |

## Si ça ne marche plus

Le script dépend de la structure actuelle du site (classes CSS des cartes, adresses des API). Si le site change, les pastilles peuvent disparaître : il faudra adapter le script.
