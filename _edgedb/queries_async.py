#
# Copyright (c) 2019 MagicStack Inc.
# All rights reserved.
#
# See LICENSE for details.
##


import edgedb


ASYNC = True


async def connect(ctx):
    return await edgedb.async_connect(
        user=ctx.edgedb_user, database='edgedb_bench',
        host=ctx.db_host, port=ctx.edgedb_port)


async def close(ctx, conn):
    await conn.aclose()


async def load_ids(ctx, conn):
    d = await conn.fetchone('''
        WITH
            U := User {id, r := random()},
            M := Movie {id, r := random()},
            P := Person {id, r := random()}
        SELECT (
            users := array_agg((SELECT U ORDER BY U.r LIMIT <int64>$lim).id),
            movies := array_agg((SELECT M ORDER BY M.r LIMIT <int64>$lim).id),
            people := array_agg((SELECT P ORDER BY P.r LIMIT <int64>$lim).id),
        );
    ''', lim=ctx.number_of_ids)

    return dict(
        get_user=list(d.users),
        get_movie=list(d.movies),
        get_person=list(d.people),
    )


async def get_user(conn, id):
    return await conn.fetchone_json('''
        SELECT User {
            id,
            name,
            image,
            latest_reviews := (
                WITH UserReviews := User.<author[IS Review]
                SELECT UserReviews {
                    id,
                    body,
                    rating,
                    movie: {
                        id,
                        image,
                        title,
                        avg_rating
                    }
                }
                ORDER BY .creation_time DESC
                LIMIT 10
            )
        }
        FILTER .id = <uuid>$id
    ''', id=id)


async def get_movie(conn, id):
    return await conn.fetchone_json('''
        SELECT Movie {
            id,
            image,
            title,
            year,
            description,
            avg_rating,

            directors: {
                id,
                full_name,
                image,
            }
            ORDER BY Movie.directors@list_order EMPTY LAST
                THEN Movie.directors.last_name,

            cast: {
                id,
                full_name,
                image,
            }
            ORDER BY Movie.cast@list_order EMPTY LAST
                THEN Movie.cast.last_name,

            reviews := (
                SELECT Movie.<movie[IS Review] {
                    id,
                    body,
                    rating,
                    author: {
                        id,
                        name,
                        image,
                    }
                }
                ORDER BY .creation_time DESC
            ),
        }
        FILTER .id = <uuid>$id
    ''', id=id)


async def get_person(conn, id):
    return await conn.fetchone_json('''
        SELECT Person {
            id,
            full_name,
            image,
            bio,

            acted_in := (
                WITH M := Person.<cast[IS Movie]
                SELECT M {
                    id,
                    image,
                    title,
                    year,
                    avg_rating
                }
                ORDER BY .year ASC THEN .title ASC
            ),

            directed := (
                WITH M := Person.<directors[IS Movie]
                SELECT M {
                    id,
                    image,
                    title,
                    year,
                    avg_rating
                }
                ORDER BY .year ASC THEN .title ASC
            ),
        }
        FILTER .id = <uuid>$id
    ''', id=id)
