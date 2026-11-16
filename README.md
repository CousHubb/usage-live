# usage-live

Un mod pour Claude Code qui affiche une bande fine au-dessus du message, avec ce que montre `/usage` et l'état du cache :

```
5 h ████████ 96 % · reset dans 1 h 57    7 j ███████░ 76 % · reset dans 1 j 4 h
Contexte 11 %    Cache CHAUD 60 min    Prochain message ≈ 0,01 $
```

- **5 h / 7 j** : la part utilisée de tes limites d'abonnement, et le temps avant leur remise à zéro.
- **Contexte** : le remplissage de la discussion.
- **Cache** : CHAUD avec les minutes restantes, ou FROID.
- **Prochain message** : le coût estimé pour que Claude relise la discussion, au tarif du modèle utilisé (lecture du cache s'il est chaud, réécriture s'il est froid). Ton nouveau texte et la réponse ne sont pas comptés.

Les chiffres se mettent à jour après chaque réponse de Claude. Les limites n'apparaissent qu'avec un abonnement Pro ou Max.

## Installation

À l'invite d'une session dans un terminal :

```
/plugin install usage-live --marketplace CousHubb/usage-live
```

Réponds `y` pour ajouter le marketplace, puis choisis la portée (Entrée pour « user »).

Depuis un shell :

```
claude plugin install usage-live --marketplace CousHubb/usage-live
```

Dans l'app desktop, où `/plugin` ne fonctionne pas : clique sur + à côté de la zone de saisie, puis Plugins, Add marketplace avec `CousHubb/usage-live`, puis Add plugin.

## Relance du cache

Avec un abonnement, le mod garde le cache chaud : pour une discussion de plus de 50 000 tokens, il envoie une mini-question 55 minutes après ta dernière requête. Elle relit la discussion depuis le cache, ce qui le prolonge d'une heure, sans rien ajouter à la discussion.

Les relances s'arrêtent dès qu'elles coûteraient, cumulées depuis ton dernier message, plus cher que de laisser le cache refroidir. Chaque relance consomme un peu de quota, et une discussion laissée ouverte peut être relancée pendant plus d'une journée.

- `/usage-live` indique si la relance est activée.
- `/usage-live relance off` la coupe, `/usage-live relance on` la rétablit. Le choix est gardé d'une session à l'autre.

## Limites connues

- La durée du cache (1 h avec un abonnement, 5 min sinon) est supposée : le mod ne peut pas la lire dans Claude Code.
- Les tarifs par modèle sont écrits dans `hooks/register.tsx` (table de novembre 2026) et sont à mettre à jour s'ils changent.
- L'interface du mod est en français.

## Développement

```
claude plugin validate .
claude plugin test .
```

## Licence

[MIT](LICENSE)
