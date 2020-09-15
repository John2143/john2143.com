use actix_web::{web, App, HttpRequest, HttpServer, Responder};

async fn test(req: HttpRequest) -> impl Responder {
    format!("Hello World")
}

const redirects: &[(&str, &str)] = &[
    ("/", "https://github.com/John2143"),
];

use actix_web::body::Body;
fn create_server(app: &mut App<AppEntry, Body>) {
    let mut app = App::new();

    for (src, dest) in redirects.into_iter() {
    }
}

#[actix_rt::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| {
        let mut app = App::new();
        create_server(&mut app);
        app
    })
    .bind("0.0.0.0:8000")?
    .run()
    .await
}
