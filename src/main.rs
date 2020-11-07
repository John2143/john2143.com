#![allow(unused_variables)]
#![allow(dead_code)]
#![allow(unused_imports)]

use actix_http::http;
use actix_multipart::Multipart;
use actix_web::{
    get,
    middleware,
    post,
    web,
    App,
    Error,
    HttpRequest,
    HttpResponse,
    HttpServer,
    Responder,
};
use futures::{StreamExt, TryStreamExt};

use std::io::Write;

use smol_str::SmolStr;

enum UserAuth {
    Ok,
    Err,
}

fn is_user_authenticated(formname: &str) -> UserAuth {
    UserAuth::Ok
}

fn random_string() -> SmolStr {
    "abcd".into()
}

#[post("/uf")]
async fn upload(mut payload: Multipart) -> Result<HttpResponse, HttpResponse> {
    let fileurl = random_string();
    if let Ok(Some(mut field)) = payload.try_next().await {
        let cd: http::header::ContentDisposition = field.content_disposition().unwrap();
        println!("{}", cd.get_name().unwrap());

        if cd.disposition != http::header::DispositionType::FormData {
            return Err(HttpResponse::BadRequest()
                .reason("Files must be form data")
                .finish());
        }

        let name = cd.get_name().ok_or_else(|| {
            HttpResponse::BadRequest()
                .reason("No upload key in name")
                .finish()
        })?;

        if let UserAuth::Err = is_user_authenticated(&name) {
            return Err(HttpResponse::Unauthorized()
                .reason("Upload key is invalid")
                .finish());
        }

        let upload_filename = cd.get_filename().ok_or("unknown.bin");

        let local_filename = format!("./juushFiles/{}", &fileurl);
        let mut file = web::block(|| ::std::fs::File::create(local_filename))
            .await
            .unwrap();

        while let Some(chunk) = field.next().await {
            let data = chunk.unwrap();

            file = web::block(move || file.write_all(&data).map(|_| file))
                .await
                .map_err(|_| HttpResponse::InternalServerError().finish())?;
        }
    }

    Ok(format!("https://localhost:8000/{}", &fileurl).into())
}

#[get("/test/thumb")]
async fn testthumb(_req: HttpRequest) -> impl Responder {
    format!("Hello World")
}

#[get("/test")]
async fn test(_req: HttpRequest) -> impl Responder {
    format!("Hello World")
}

const REDIRECTS: &[(&'static str, &'static str)] = &[
    ("/", "https://github.com/John2143"),
    ("/git", "https://github.com/John2143"),
    ("/teamspeak", "ts3server://john2143.com"),
    ("/steam", "//steamcommunity.com/profiles/76561198027378405"),
    ("/osu", "//osu.ppy.sh/u/2563776"),
    (
        "/poe",
        "https://www.pathofexile.com/account/view-profile/John2143658709",
    ),
    (
        "/poe/guild",
        "https://www.pathofexile.com/guild/profile/537964",
    ),
];

#[actix_rt::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| {
        let mut app = App::new().wrap(middleware::Logger::default());
        for (src, dest) in REDIRECTS.iter() {
            let svc = web::resource(*src).route(web::get().to(move || {
                HttpResponse::MovedPermanently()
                    .header(http::header::LOCATION, *dest)
                    .finish()
            }));

            app = app.service(svc);
        }
        app = app.service(test);
        app = app.service(upload);
        app = app.service(testthumb);
        app
    })
    .bind("0.0.0.0:8000")?
    .run()
    .await
}
