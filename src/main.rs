use actix_http::{http, Request, Response};
use actix_multipart::Multipart;
use actix_web::{
    get, middleware, post, web, App, HttpRequest, HttpResponse, HttpServer, Responder,
};
use futures::{StreamExt, TryStreamExt};

#[post("/uf")]
async fn upload(req: HttpRequest, mut payload: Multipart) -> impl Responder {
    if let Ok(Some(mut field)) = payload.try_next().await {
        println!("{:?}", field);
        println!("{}", field.content_disposition().unwrap());
    }

    "https://localhost:8000/test"
}

#[get("/test/thumb")]
async fn testthumb(req: HttpRequest) -> impl Responder {
    format!("Hello World")
}

#[get("/test")]
async fn test(req: HttpRequest) -> impl Responder {
    format!("Hello World")
}

const REDIRECTS: &[(&'static str, &'static str)] = &[("/", "https://github.com/John2143")];

#[actix_rt::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| {
        let mut app = App::new();
        for (src, dest) in REDIRECTS.iter() {
            println!("Route: {} -> {}", src, dest);
            let svc = web::resource(*src).route(web::get().to(move || {
                println!("hit");
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
