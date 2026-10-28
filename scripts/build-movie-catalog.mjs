import fs from "node:fs/promises";

const TOKEN = process.env.TMDB_BEARER_TOKEN;
const TARGET_PER_BUCKET = 64;
const MAX_PAGES_PER_SOURCE_GENRE = 8;
const PAUSE_MS = 90;
const TODAY = new Date().toISOString().slice(0, 10);

const DECADES = [
  { label: "1970s", start: "1970-01-01", end: "1979-12-31" },
  { label: "1980s", start: "1980-01-01", end: "1989-12-31" },
  { label: "1990s", start: "1990-01-01", end: "1999-12-31" },
  { label: "2000s", start: "2000-01-01", end: "2009-12-31" },
  { label: "2010s", start: "2010-01-01", end: "2019-12-31" },
 { label: "2020s", start: "2020-01-01", end: TODAY }
];

const CATEGORY_SOURCES = {
  "Action": ["Action"],
  "Adventure": ["Adventure"],
  "Comedy": ["Comedy"],
  "Crime / Thriller": ["Crime", "Mystery", "Thriller"],
  "Drama": ["Drama"],
  "Fantasy": ["Fantasy"],
  "Horror": ["Horror"],
  "Musical": ["Music"],
  "Romance": ["Romance"],
  "Science Fiction": ["Science Fiction"],
  "War / Western": ["War", "Western"]
};

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function slugify(title, year) {
  const normalized = String(title)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return `${normalized}-${year}`;
}

async function tmdbRequest(path, parameters = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);

  Object.entries(parameters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `TMDb request failed: ${response.status} ${response.statusText}\n${body}`
    );
  }

  await sleep(PAUSE_MS);

  return response.json();
}

function getCategoriesForMovie(genreIds, tmdbGenreIdsByName) {
  const categories = [];

  for (const [category, sourceGenreNames] of Object.entries(CATEGORY_SOURCES)) {
    const sourceGenreIds = sourceGenreNames
      .map(name => tmdbGenreIdsByName.get(name))
      .filter(Boolean);

    if (sourceGenreIds.some(id => genreIds.includes(id))) {
      categories.push(category);
    }
  }

  return categories.length ? categories : ["Drama"];
}

function getTopTwoActors(credits) {
  const actors = (credits.cast || [])
    .filter(person => person.known_for_department === "Acting")
    .slice(0, 2)
    .map(person => person.name);

  while (actors.length < 2) {
    actors.push("Unknown");
  }

  return actors;
}

async function main() {
  if (!TOKEN) {
    throw new Error(
      "TMDB_BEARER_TOKEN is missing. Add it in GitHub repository secrets."
    );
  }

  console.log("Loading TMDb genre list...");

  const genreData = await tmdbRequest("/genre/movie/list", {
    language: "en-US"
  });

  const tmdbGenreIdsByName = new Map(
    genreData.genres.map(genre => [genre.name, genre.id])
  );

  const animationGenreId = tmdbGenreIdsByName.get("Animation");  

  const discoveredMovies = new Map();
  const coverage = {};

  for (const decade of DECADES) {
    for (const [category, sourceGenreNames] of Object.entries(CATEGORY_SOURCES)) {
      const bucketKey = `${decade.label} ${category}`;
      const bucketMovieIds = new Set();

      console.log(`Building: ${bucketKey}`);

      for (const sourceGenreName of sourceGenreNames) {
        const sourceGenreId = tmdbGenreIdsByName.get(sourceGenreName);

        if (!sourceGenreId || bucketMovieIds.size >= TARGET_PER_BUCKET) {
          continue;
        }

        for (
          let page = 1;
          page <= MAX_PAGES_PER_SOURCE_GENRE &&
          bucketMovieIds.size < TARGET_PER_BUCKET;
          page += 1
        ) {
        const cutoffDate = decade.end < TODAY
  ? decade.end
  : TODAY;

const result = await tmdbRequest("/discover/movie", {
  language: "en-US",
  include_adult: "false",
  include_video: "false",

  region: "US",
  with_release_type: "3|2",

  "release_date.gte": decade.start,
  "release_date.lte": cutoffDate,

  sort_by: "vote_average.desc",
  "vote_average.gte": "6.5",
  "vote_count.gte": "200",

   with_genres: sourceGenreId,
   without_genres: animationGenreId,
  
  page
});

          for (const movie of result.results || []) {
            const cutoffDate = decade.end < TODAY
  ? decade.end
  : TODAY;

if (
  !movie.release_date ||
  movie.release_date < decade.start ||
  movie.release_date > cutoffDate
) {
  continue;
}
            if (
              !movie.id ||
              !movie.title ||
              !movie.release_date ||
              !movie.poster_path
            ) {
              continue;
            }

            const releaseYear = movie.release_date.slice(0, 4);

            if (!releaseYear) {
              continue;
            }

            bucketMovieIds.add(movie.id);

            if (!discoveredMovies.has(movie.id)) {
              discoveredMovies.set(movie.id, {
                tmdbId: movie.id,
                title: movie.title,
                year: Number(releaseYear),
                decade: decade.label,
                genreIds: movie.genre_ids || [],
                posterPath: movie.poster_path
              });
            }

            if (bucketMovieIds.size >= TARGET_PER_BUCKET) {
              break;
            }
          }
        }
      }

      coverage[bucketKey] = {
        decade: decade.label,
        category,
        found: bucketMovieIds.size,
        target: TARGET_PER_BUCKET,
        ready: bucketMovieIds.size >= TARGET_PER_BUCKET
      };
    }
  }

  console.log(
    `Discover step complete. Fetching credits for ${discoveredMovies.size} movies...`
  );

  const movies = [];

  for (const movie of discoveredMovies.values()) {
    try {
      const credits = await tmdbRequest(`/movie/${movie.tmdbId}/credits`, {
        language: "en-US"
      });

      const genres = getCategoriesForMovie(
        movie.genreIds,
        tmdbGenreIdsByName
      );

      movies.push({
        id: slugify(movie.title, movie.year),
        tmdbId: movie.tmdbId,
        title: movie.title,
        year: movie.year,
        decade: movie.decade,
        genres,
        actors: getTopTwoActors(credits),
        posterFile: `${slugify(movie.title, movie.year)}.jpg`,
        posterPath: movie.posterPath
      });
    } catch (error) {
      console.warn(
        `Skipping credits for ${movie.title} (${movie.year}): ${error.message}`
      );
    }
  }

  movies.sort((a, b) => {
    return (
      a.year - b.year ||
      a.title.localeCompare(b.title)
    );
  });

  const catalog = {
    generatedAt: new Date().toISOString(),
    source: "TMDb",
    targetPerGenreDecade: TARGET_PER_BUCKET,
    movies
  };

  const coverageReport = {
    generatedAt: new Date().toISOString(),
    targetPerGenreDecade: TARGET_PER_BUCKET,
    buckets: Object.values(coverage).sort((a, b) => {
      return (
        a.decade.localeCompare(b.decade) ||
        a.category.localeCompare(b.category)
      );
    })
  };

  await fs.writeFile(
    "movie-catalog.json",
    `${JSON.stringify(catalog, null, 2)}\n`,
    "utf8"
  );

  await fs.writeFile(
    "catalog-coverage.json",
    `${JSON.stringify(coverageReport, null, 2)}\n`,
    "utf8"
  );

  const readyCount = coverageReport.buckets.filter(
    bucket => bucket.ready
  ).length;

  console.log(`Generated ${movies.length} unique movie records.`);
  console.log(
    `${readyCount} of ${coverageReport.buckets.length} genre/decade buckets reached ${TARGET_PER_BUCKET}.`
  );
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
