//! Diagnostic réseau (apps mobiles) : quand le module HTTP ne joint pas un site, il ne renvoie que
//! « error sending request ». On refait la requête ici pour obtenir la vraie cause (DNS, TLS, IPv6…).

use std::error::Error as _;
use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

fn chain(e: &reqwest::Error) -> String {
    let mut s = e.to_string();
    let mut src = e.source();
    while let Some(c) = src {
        s.push_str(" → ");
        s.push_str(&c.to_string());
        src = c.source();
    }
    s
}

async fn essai(url: &str, ipv4: bool) -> String {
    let mut b = reqwest::Client::builder().timeout(Duration::from_secs(12)).connect_timeout(Duration::from_secs(8));
    if ipv4 {
        b = b.local_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    }
    match b.build() {
        Err(e) => format!("client : {}", chain(&e)),
        Ok(c) => match c.get(url).send().await {
            Ok(r) => format!("HTTP {}", r.status().as_u16()),
            Err(e) => chain(&e),
        },
    }
}

/// Résultat lisible : adresses DNS, requête normale, requête forcée en IPv4.
#[tauri::command]
pub async fn diagnostic_reseau(url: String) -> String {
    let host = reqwest::Url::parse(&url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    let dns = match tokio::net::lookup_host(format!("{host}:443")).await {
        Ok(addrs) => {
            let list: Vec<String> = addrs.map(|a| a.ip().to_string()).take(4).collect();
            if list.is_empty() { "DNS : aucune adresse".to_string() } else { format!("DNS : {}", list.join(", ")) }
        }
        Err(e) => format!("DNS : échec ({e})"),
    };
    let normal = essai(&url, false).await;
    let v4 = essai(&url, true).await;
    format!("{dns} | requête : {normal} | IPv4 seul : {v4}")
}
