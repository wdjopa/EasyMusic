# 🎸 EasyMusic

Trouvez les **accords de guitare** de n'importe quelle chanson et **transposez-la dans la tessiture de votre voix**.
Tout fonctionne dans le navigateur : aucun fichier n'est envoyé à un serveur.

## Fonctionnalités

1. **Deux sources** :
   - **une vidéo YouTube** : collez le lien, la vidéo est lue dans le lecteur officiel intégré et EasyMusic
     écoute le son de l'onglet (partage d'onglet du navigateur) pendant la lecture. Les accords apparaissent au fur et
     à mesure, puis se synchronisent sur la vidéo. Aucun téléchargement depuis YouTube (conforme à ses conditions
     d'utilisation). Chrome/Edge sur ordinateur ; l'écoute dure le temps de la chanson ;
   - **un fichier audio** (MP3, WAV, M4A, OGG, FLAC…), analysé instantanément.
2. **Détection des accords**
   - chromagramme (énergie des 12 notes) sur les pics spectraux ;
   - reconnaissance par gabarits harmoniques (majeur, mineur, 7, maj7, m7, dim, sus2, sus4) + analyse de la basse ;
   - lissage temporel par algorithme de Viterbi ;
   - détection de la tonalité (profils de Krumhansl).
3. **Test de voix au micro** (détection de hauteur YIN) ou choix d'un type de voix (basse → soprano).
4. **Estimation de la tessiture de la mélodie** (sommation harmonique), ajustable à la main.
5. **Transposition automatique** : calcule le décalage qui place la mélodie dans votre voix — et sait qu'un homme
   peut chanter une chanson de femme une octave plus bas sans changer de tonalité.
6. **Transposition de l'audio** sans changer le tempo (vocodeur de phase avec verrouillage de phase), téléchargeable en WAV.
7. **Capodastre** suggéré pour jouer avec des formes faciles, **diagrammes d'accords**, grille synchronisée avec la lecture,
   mode « accords simplifiés », copie de la grille.

## Démarrer

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # tests des algorithmes sur de l'audio synthétique
npm run build    # version de production dans dist/
```

## Structure

```
src/
  dsp/        traitement du signal (FFT, chroma, accords, tonalité, YIN, mélodie, pitch-shift, worker)
  music/      théorie musicale (transposition, tessitures, capo) et doigtés de guitare
  ui/         micro, lecteur YouTube, écoute de l'onglet, encodage WAV
  main.ts     interface
tests/        tests Vitest
```

## Limites

La détection automatique est une estimation : elle marche le mieux sur des enregistrements clairs
(guitare/piano + voix). Les accords marqués « ? » sont incertains. Utilisez uniquement des fichiers que vous avez le droit d'utiliser.
