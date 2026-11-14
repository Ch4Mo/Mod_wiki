# Mod_wiki – Prix moyen sur les cartes WikiMasters

Script utilisateur (« userscript ») qui affiche le **prix de vente moyen du marché** directement sur chaque carte de ta collection sur [wiki-masters.com](https://www.wiki-masters.com/collection), sans avoir à ouvrir la carte puis « Mettre aux enchères ».

Le prix apparaît dans une pastille `Ⓦ 39` en bas à gauche de l'image de chaque carte :

- `Ⓦ 39` : prix moyen pour la rareté de ta carte
- `Ⓦ –` : aucune vente récente pour cette rareté
- `Ⓦ …` : chargement en cours
- `Ⓦ ?` : erreur de chargement (réessaie en rechargeant la page)

## Installation sur Android

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
- Les prix sont gardés en mémoire **6 heures** dans le navigateur ; recharger la page ne refait pas les requêtes.

Le script ne fait que lire : il n'achète, ne vend ni ne modifie rien sur ton compte. Il ne contient et ne transmet aucun identifiant ; il utilise simplement ta session déjà ouverte sur le site.

## Réglages

En haut du script :

| Constante | Défaut | Rôle |
|---|---|---|
| `CACHE_TTL_MS` | 6 h | Durée de conservation des prix |
| `MAX_PARALLEL` | 2 | Requêtes simultanées max |
| `DELAY_MS` | 250 | Pause entre deux requêtes |

## Si ça ne marche plus

Le script dépend de la structure actuelle du site (classes CSS des cartes, adresses des API). Si le site change, les pastilles peuvent disparaître : il faudra adapter le script.
