"use strict";

const { Pool } = require("pg");

class App {
  constructor(options) {
    options = {
      user: "postgres_bench",
      host: "localhost",
      database: "postgres_bench",
      password: "edgedbbenchmark",
      port: 5432,
      ...(options || {})
    };
    this.pool = new Pool(options);
  }

  async fetchUser(conn, id) {
    // single query, no need for a transaction
    const res = await conn.query(
      `
      SELECT
          users.id,
          users.name,
          users.image,
          q.review_id,
          q.review_body,
          q.review_rating,
          q.movie_id,
          q.movie_image,
          q.movie_title,
          q.movie_avg_rating
      FROM
          users,
          LATERAL (
              SELECT
                  review.id AS review_id,
                  review.body AS review_body,
                  review.rating AS review_rating,
                  movie.id AS movie_id,
                  movie.image AS movie_image,
                  movie.title AS movie_title,
                  movie.avg_rating AS movie_avg_rating
              FROM
                  reviews AS review
                  INNER JOIN movies AS movie
                      ON (review.movie_id = movie.id)
              WHERE
                  review.author_id = users.id
              ORDER BY
                  review.creation_time DESC
              LIMIT 10
          ) AS q
          WHERE
          users.id = $1
      `,
      [id]
    );

    return [res];
  }

  async userDetails(id) {
    const [res] = await this.fetchUser(this.pool, id);

    var user = {
      id: res.rows[0].id,
      name: res.rows[0].name,
      image: res.rows[0].image,
      latest_reviews: res.rows.map(r => {
        return {
          id: r.review_id,
          body: r.review_body,
          rating: r.review_rating,
          movie: {
            id: r.movie_id,
            image: r.movie_image,
            title: r.movie_title,
            avg_rating: parseFloat(r.movie_avg_rating)
          }
        };
      })
    };

    return JSON.stringify(user);
  }

  async fetchPerson(conn, id) {
    var person = (await conn.query(
      `
      SELECT
          p.id,
          p.full_name,
          p.image,
          p.bio
      FROM
          persons p
      WHERE
          p.id = $1
      `,
      [id]
    )).rows[0];

    const actedInRows = (await conn.query(
      `
      SELECT
          movie.id,
          movie.image,
          movie.title,
          movie.year,
          movie.avg_rating
      FROM
          actors
          INNER JOIN movies AS movie
              ON (actors.movie_id = movie.id)
      WHERE
          actors.person_id = $1
      ORDER BY
          movie.year ASC, movie.title ASC
      `,
      [id]
    )).rows;

    const directedRows = (await conn.query(
      `
      SELECT
          movie.id,
          movie.image,
          movie.title,
          movie.year,
          movie.avg_rating
      FROM
          directors
          INNER JOIN movies AS movie
              ON (directors.movie_id = movie.id)
      WHERE
          directors.person_id = $1
      ORDER BY
          movie.year ASC, movie.title ASC
      `,
      [id]
    )).rows;

    return [person, actedInRows, directedRows];
  }

  async personDetails(id) {
    // multiple queries need to be wrapped in a transaction so that the data is
    // guaranteed to be consistent
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ");

      var [person, actedInRows, directedRows] = await this.fetchPerson(
        client,
        id
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    person.acted_in = actedInRows.map(mov => {
      mov.avg_rating = parseFloat(mov.avg_rating);
      return mov;
    });
    person.directed = directedRows.map(mov => {
      mov.avg_rating = parseFloat(mov.avg_rating);
      return mov;
    });

    return JSON.stringify(person);
  }

  async fetchMovie(conn, id) {
    var movie = (await conn.query(
      `
        SELECT
            movie.id,
            movie.image,
            movie.title,
            movie.year,
            movie.description,
            movie.avg_rating
        FROM
            movies AS movie
        WHERE
            movie.id = $1
        `,
      [id]
    )).rows[0];

    const directorsRows = (await conn.query(
      `
        SELECT
            person.id,
            person.full_name,
            person.image
        FROM
            directors
            INNER JOIN persons AS person
                ON (directors.person_id = person.id)
        WHERE
            directors.movie_id = $1
        ORDER BY
            directors.list_order NULLS LAST,
            person.last_name
        `,
      [id]
    )).rows;

    const castRows = (await conn.query(
      `
        SELECT
            person.id,
            person.full_name,
            person.image
        FROM
            actors
            INNER JOIN persons AS person
                ON (actors.person_id = person.id)
        WHERE
            actors.movie_id = $1
        ORDER BY
            actors.list_order NULLS LAST,
            person.last_name
        `,
      [id]
    )).rows;

    const reviewsRows = (await conn.query(
      `
        SELECT
            review.id,
            review.body,
            review.rating,
            author.id AS author_id,
            author.name AS author_name,
            author.image AS author_image
        FROM
            reviews AS review
            INNER JOIN users AS author
                ON (review.author_id = author.id)
        WHERE
            review.movie_id = $1
        ORDER BY
            review.creation_time DESC
        `,
      [id]
    )).rows;

    return [movie, directorsRows, castRows, reviewsRows];
  }

  async movieDetails(id) {
    // multiple queries need to be wrapped in a transaction so that the data is
    // guaranteed to be consistent
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ");

      var [movie, directorsRows, castRows, reviewsRows] = await this.fetchMovie(
        client,
        id
      );

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    movie.directors = directorsRows;
    movie.cast = castRows;
    movie.reviews = reviewsRows.map(r => {
      return {
        id: r.id,
        body: r.body,
        rating: r.rating,
        author: {
          id: r.author_id,
          name: r.author_name,
          image: r.author_image
        }
      };
    });

    return JSON.stringify(movie);
  }

  async benchQuery(query, id) {
    if (query == "get_user") {
      return await this.userDetails(id);
    } else if (query == "get_person") {
      return await this.personDetails(id);
    } else if (query == "get_movie") {
      return this.movieDetails(id);
    }
  }

  async getIDs() {
    var ids = await Promise.all([
      await this.pool.query("SELECT u.id FROM users u ORDER BY random();"),
      await this.pool.query("SELECT p.id FROM persons p ORDER BY random();"),
      await this.pool.query("SELECT m.id FROM movies m ORDER BY random();")
    ]);

    return {
      get_user: ids[0].rows.map(x => x.id),
      get_person: ids[1].rows.map(x => x.id),
      get_movie: ids[2].rows.map(x => x.id)
    };
  }
  getConnection(i) {
    return this;
  }
}
module.exports.App = App;
