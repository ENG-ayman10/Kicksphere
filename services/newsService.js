/**
 * @file newsService.js
 * @description Dynamic football news with fresh timestamps and full article content.
 */

const generateNews = () => {
  const now = Date.now();
  return [
    {
      id: "news_1",
      title: "Mbappé Scores Stunning Hat-Trick in El Clásico",
      excerpt: "Kylian Mbappé delivered a masterclass performance as Real Madrid dominated Barcelona 4-1 at the Santiago Bernabéu.",
      content: "In what will be remembered as one of the greatest El Clásico performances in recent memory, Kylian Mbappé scored a stunning hat-trick to lead Real Madrid to a comprehensive 4-1 victory over Barcelona.\n\nThe French superstar opened the scoring in the 12th minute with a powerful strike from outside the box, before doubling his tally just before half-time with a delicate chip over the goalkeeper.\n\nBarcelona pulled one back through Lamine Yamal early in the second half, but Mbappé completed his hat-trick in the 78th minute with a clinical finish after a brilliant counter-attack. Jude Bellingham added a fourth in stoppage time to seal a memorable night for Los Blancos.\n\n\"This is why I came to Real Madrid,\" Mbappé told reporters after the match. \"Nights like these are what dreams are made of.\"",
      category: "Match Report",
      imageUrl: "https://images.unsplash.com/photo-1574629810360-7efbb1925619?w=800&q=80",
      publishedAt: new Date(now - 1000 * 60 * 25).toISOString(),
      author: "KickSphere Editorial",
      tags: ["Real Madrid", "Barcelona", "La Liga", "Mbappé"]
    },
    {
      id: "news_2",
      title: "Champions League Semi-Final Draw: Real Madrid vs Arsenal",
      excerpt: "The draw for the UEFA Champions League semi-finals has produced a blockbuster clash between Real Madrid and Arsenal.",
      content: "UEFA has confirmed the Champions League semi-final draw, and football fans around the world are in for a treat.\n\nRecord 15-time winners Real Madrid will face Arsenal in what promises to be an epic two-legged tie. The Gunners, who have been in sensational form under Mikel Arteta, will travel to the Santiago Bernabéu for the first leg before hosting the return at the Emirates Stadium.\n\nIn the other semi-final, Inter Milan will take on Bayern Munich in a repeat of the 2010 final.\n\nThe first legs are scheduled for April 29-30, with the return legs on May 6-7. The final will be held at the Allianz Arena in Munich on May 31.\n\n\"We respect Arsenal, but Real Madrid fears no one in this competition,\" said Carlo Ancelotti.",
      category: "Champions League",
      imageUrl: "https://images.unsplash.com/photo-1600250395178-40fe752e5189?w=800&q=80",
      publishedAt: new Date(now - 1000 * 60 * 90).toISOString(),
      author: "UEFA Correspondent",
      tags: ["Champions League", "Real Madrid", "Arsenal", "UEFA"]
    },
    {
      id: "news_3",
      title: "Haaland Breaks Premier League Scoring Record",
      excerpt: "Erling Haaland has shattered the Premier League single-season scoring record with his 37th goal of the campaign.",
      content: "Manchester City's Norwegian striker Erling Haaland has officially broken the Premier League single-season scoring record, netting his 37th league goal in City's 3-0 victory over Aston Villa.\n\nThe 25-year-old surpassed the previous record of 36 goals set by Andy Cole and Alan Shearer, and still has five matches remaining to extend his tally.\n\n\"Records are there to be broken,\" Haaland said with a smile. \"But the most important thing is winning trophies with this team.\"\n\nPep Guardiola hailed his striker as \"the best number 9 in the world\" and predicted that the record could stand for decades.\n\nHaaland's incredible goalscoring form has been the driving force behind City's title challenge this season.",
      category: "Premier League",
      imageUrl: "https://images.unsplash.com/photo-1518605368461-1e12d1b82736?w=800&q=80",
      publishedAt: new Date(now - 1000 * 60 * 180).toISOString(),
      author: "Premier League Bureau",
      tags: ["Manchester City", "Haaland", "Premier League", "Record"]
    },
    {
      id: "news_4",
      title: "Transfer Exclusive: Liverpool Close to €120M Summer Deal",
      excerpt: "Liverpool are reportedly on the verge of completing a club-record €120 million transfer for a world-class midfielder.",
      content: "According to multiple reliable sources, Liverpool are in advanced negotiations to sign a world-class midfielder in what would be the biggest transfer in the club's history.\n\nThe deal, reportedly worth €120 million plus add-ons, would make the player the most expensive signing in Premier League history.\n\nNew manager Arne Slot has identified strengthening the midfield as his top priority, and the club's owners at Fenway Sports Group have given the green light for the record-breaking expenditure.\n\n\"Liverpool are building something special,\" a source close to the negotiations told KickSphere. \"This signing would signal their intent to compete for every trophy next season.\"\n\nAn official announcement is expected within the next two weeks.",
      category: "Transfers",
      imageUrl: "https://images.unsplash.com/photo-1517466787929-bc90951d0974?w=800&q=80",
      publishedAt: new Date(now - 1000 * 60 * 60 * 4).toISOString(),
      author: "Transfer Insider",
      tags: ["Liverpool", "Transfers", "Premier League"]
    },
    {
      id: "news_5",
      title: "Bayern Munich Appoint New Manager After Shock Departure",
      excerpt: "Bayern Munich have moved quickly to appoint a new head coach following the unexpected resignation of their previous manager.",
      content: "Bundesliga giants Bayern Munich have confirmed the appointment of their new head coach on a three-year deal, following the surprise departure of their previous manager.\n\nThe new appointment comes with significant experience in European football and has promised to bring an attacking brand of football to the Allianz Arena.\n\n\"Bayern Munich is one of the biggest clubs in the world,\" the new manager said at his unveiling press conference. \"The expectation here is to win everything, and that is exactly what we intend to do.\"\n\nThe appointment has been widely praised by pundits and fans alike, with many expecting Bayern to mount a serious challenge for the Champions League next season.\n\nHarry Kane, Bayern's star striker, welcomed the new appointment on social media, posting: \"Excited for the new chapter. Let's get to work.\"",
      category: "Bundesliga",
      imageUrl: "https://images.unsplash.com/photo-1489944440615-453fc2b6a9a9?w=800&q=80",
      publishedAt: new Date(now - 1000 * 60 * 60 * 8).toISOString(),
      author: "Bundesliga Desk",
      tags: ["Bayern Munich", "Bundesliga", "Manager"]
    },
    {
      id: "news_6",
      title: "Serie A Title Race Goes Down to Final Matchday",
      excerpt: "Inter Milan and Napoli are separated by just one point heading into the final matchday of the Serie A season.",
      content: "The Serie A title race will go down to the wire after Inter Milan and Napoli both won their penultimate matches of the season.\n\nInter, who lead by a single point, will travel to Lazio on the final day, while Napoli host Roma at the Stadio Diego Armando Maradona.\n\nLautaro Martinez, Inter's captain and top scorer, has been in sensational form, scoring 28 goals this season. Meanwhile, Victor Osimhen has netted 25 for Napoli.\n\n\"We know what we have to do,\" said Inter coach Simone Inzaghi. \"One more game, one more win, and the Scudetto is ours.\"\n\nThe final matchday kicks off simultaneously at 20:45 CET on Sunday.",
      category: "Serie A",
      imageUrl: "https://images.unsplash.com/photo-1508098682722-e99c43a406b2?w=800&q=80",
      publishedAt: new Date(now - 1000 * 60 * 60 * 12).toISOString(),
      author: "Serie A Bureau",
      tags: ["Inter Milan", "Napoli", "Serie A", "Title Race"]
    },
  ];
};

exports.getLatestNews = async (limit = 10) => {
  return generateNews().slice(0, limit);
};
