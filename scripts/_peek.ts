import { createDb } from '../src/lib/db/create-db';
import { listCategories, listFacetValues } from '../src/lib/db/wiki-repo';

const { db, close } = await createDb({ pgliteDataDir: '.data/pglite' });
const cats = await listCategories(db, 5);
const biomes = await listFacetValues(db, 'biome');
const stations = await listFacetValues(db, 'station');
console.log('CATEGORIES', cats.length);
console.log(cats.slice(0, 20));
console.log('BIOMES', biomes.length, biomes);
console.log('STATIONS', stations.length, stations);
await close();
