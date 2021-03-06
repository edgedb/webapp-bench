import "reflect-metadata";
import { Connection, ConnectionOptions } from "typeorm";
import { User } from "./entity/User";
import { Person } from "./entity/Person";
import { Movie, MovieView } from "./entity/Movie";
import { Review } from "./entity/Review";
import { Directors } from "./entity/Directors";
import { Cast } from "./entity/Cast";

var defaultOptions: ConnectionOptions = {
  type: "postgres",
  host: "localhost",
  port: 5432,
  username: "typeorm_bench",
  password: "edgedbbenchmark",
  database: "typeorm_bench",
  synchronize: false,
  logging: false,
  entities: [User, Person, Movie, MovieView, Review, Directors, Cast]
};

export class App extends Connection {
  constructor(options: ConnectionOptions) {
    var opts: ConnectionOptions = {
      ...defaultOptions
    };
    Object.assign(opts, options || {});

    super(opts);
  }

  async benchQuery(query: string, id) {
    var method;

    if (query == "get_user") {
      method = userDetails.bind(this);
    } else if (query == "get_person") {
      method = personDetails.bind(this);
    } else if (query == "get_movie") {
      method = movieDetails.bind(this);
    }

    return await method(id);
  }

  async getIDs() {
    var ids = await Promise.all([
      this.getRepository(User).find({ select: ["id"] }),
      this.getRepository(Person).find({ select: ["id"] }),
      this.getRepository(Movie).find({ select: ["id"] })
    ]);

    return {
      get_user: ids[0].map(x => x.id),
      get_person: ids[1].map(x => x.id),
      get_movie: ids[2].map(x => x.id)
    };
  }

  getConnection(i: number) {
    return this;
  }
}

export async function userDetails(this, id: number): Promise<string> {
  var user = await this.createQueryBuilder(User, "user")
    .select(["user", "review.id", "review.body", "review.rating"])
    .leftJoin("user.reviews", "review")
    .leftJoinAndMapOne(
      "review.movie",
      MovieView,
      "movie",
      "movie.id = review.movie_id"
    )
    .where("user.id = :id", { id: id })
    .orderBy("review.creation_time", "DESC")
    .getOne();

  user.latest_reviews = user.reviews.slice(0, 10).map(rev => {
    rev.movie = {
      id: rev.movie.id,
      image: rev.movie.image,
      title: rev.movie.title,
      // PostgreSQL floats are returned as strings
      avg_rating: parseFloat(rev.movie.avg_rating)
    };
    return rev;
  });
  delete user.reviews;
  var result = user;

  return JSON.stringify(result);
}

export async function personDetails(this, id: number): Promise<string> {
  var person = await this.createQueryBuilder(Person, "person")
    .leftJoinAndSelect("person.directed", "directors")
    .leftJoinAndMapOne(
      "directors.movie",
      MovieView,
      "dmovie",
      "dmovie.id = directors.movie_id"
    )
    .leftJoinAndSelect("person.acted_in", "cast")
    .leftJoinAndMapOne(
      "cast.movie",
      MovieView,
      "cmovie",
      "cmovie.id = cast.movie_id"
    )
    .where("person.id = :id", { id: id })
    .orderBy("dmovie.year", "ASC")
    .addOrderBy("cmovie.year", "ASC")
    .getOne();

  for (let fname of ["acted_in", "directed"]) {
    person[fname] = person[fname].map(rel => {
      return {
        id: rel.movie.id,
        image: rel.movie.image,
        title: rel.movie.title,
        year: rel.movie.year,
        // PostgreSQL floats are returned as strings
        avg_rating: parseFloat(rel.movie.avg_rating)
      };
    });
  }
  var result = {
    id: person.id,
    full_name: person.get_full_name(),
    image: person.image,
    bio: person.bio,
    acted_in: person.acted_in,
    directed: person.directed
  };

  return JSON.stringify(result);
}

export async function movieDetails(this, id: number): Promise<string> {
  var movie = await this.createQueryBuilder(Movie, "movie")
    .select([
      "movie.id",
      "movie.image",
      "movie.title",
      "movie.year",
      "movie.description",
      "directors.list_order",
      "cast.list_order",
      "dperson.id",
      "dperson.first_name",
      "dperson.middle_name",
      "dperson.last_name",
      "dperson.image",
      "cperson.id",
      "cperson.first_name",
      "cperson.middle_name",
      "cperson.last_name",
      "cperson.image",
      "review.id",
      "review.body",
      "review.rating",
      "user.id",
      "user.name",
      "user.image"
    ])
    .leftJoinAndSelect("movie.directors", "directors")
    .leftJoinAndSelect("directors.person", "dperson")
    .leftJoinAndSelect("movie.cast", "cast")
    .leftJoinAndSelect("cast.person", "cperson")
    .leftJoinAndSelect("movie.reviews", "review")
    .leftJoinAndSelect("review.author", "user")
    .where("movie.id = :id", { id: id })
    .orderBy("directors.list_order", "ASC")
    .addOrderBy("dperson.last_name", "ASC")
    .addOrderBy("cast.list_order", "ASC")
    .addOrderBy("cperson.last_name", "ASC")
    .addOrderBy("review.creation_time", "DESC")
    .getOne();

  movie.avg_rating =
    movie.reviews.reduce((total, r) => total + r.rating, 0) /
    movie.reviews.length;

  for (let fname of ["directors", "cast"]) {
    movie[fname] = movie[fname].map(rel => {
      return {
        id: rel.person.id,
        full_name: rel.person.get_full_name(),
        image: rel.person.image
      };
    });
  }
  movie.reviews = movie.reviews.map(rev => {
    delete rev.creation_time;
    return rev;
  });
  var result = movie;

  return JSON.stringify(result);
}
