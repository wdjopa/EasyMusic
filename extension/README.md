# EnjoySing Helper (extension de navigateur)

Quand YouTube bloque le serveur d'EnjoySing (« vérification anti-robot »), cette extension prend le relais :
elle ouvre la vidéo dans un onglet YouTube **muet, en arrière-plan**, l'écoute du début à la fin depuis
**votre** navigateur (votre connexion, donc pas de blocage), puis donne le son à EnjoySing. L'analyse se fait
ensuite dans votre navigateur et le son y reste enregistré : la chanson n'est plus jamais téléchargée.

- L'écoute prend la durée de la chanson (temps réel). Vous pouvez utiliser l'app pendant ce temps,
  ou ajouter plusieurs chansons à la file d'attente.
- Les publicités YouTube sont passées quand c'est possible, et ne sont jamais enregistrées.
- L'extension n'agit que sur enjoysing.resub.me (et localhost pour le développement) et sur les onglets
  YouTube qu'elle a elle-même ouverts. Elle n'envoie rien à personne d'autre.

## Installer (Chrome, Edge, Brave, Opera)

1. Téléchargez **enjoysing-helper.zip** (lien « 🧩 Extension EnjoySing Helper » en bas de la page d'EnjoySing) et décompressez-le.
2. Ouvrez `chrome://extensions`, activez le **mode développeur** (en haut à droite).
3. **Charger l'extension non empaquetée** › choisissez le dossier `enjoysing-helper` décompressé.
4. Rechargez EnjoySing : les chansons bloquées passent désormais par l'extension.

## Installer (Firefox 121+)

`about:debugging#/runtime/this-firefox` › **Charger un module complémentaire temporaire** › le fichier `manifest.json` du dossier décompressé
(temporaire : à refaire après chaque redémarrage de Firefox, tant que l'extension n'est pas signée par Mozilla).

## Publier

Le Chrome Web Store refuse en général les extensions qui récupèrent le contenu de YouTube. Pistes :
distribution directe (mode développeur, ci-dessus), ou extension Firefox signée « non listée » sur
addons.mozilla.org (signature gratuite, installation en un clic).

Le zip est créé automatiquement par `npm run build` (`dist/enjoysing-helper.zip`), ou à la main : `npm run ext:zip`.
