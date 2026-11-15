// Notifiche in background per Gestione
self.addEventListener("notificationclick",function(e){
  e.notification.close();
  var url=new URL((e.notification.data&&e.notification.data.url)||"./",self.registration.scope).href;
  e.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(function(list){
    for(var i=0;i<list.length;i++){
      var c=list[i];
      if(c.url.indexOf(self.registration.scope)===0&&"focus" in c){c.postMessage({url:url});return c.focus()}
    }
    return clients.openWindow(url);
  }));
});
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js","https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js");
firebase.initializeApp({
  apiKey:"AIzaSyDypaXlE3mPUjSf9GUQPbHSBOHZ_TBa_PM",
  authDomain:"gestione-motoabb.firebaseapp.com",
  projectId:"gestione-motoabb",
  storageBucket:"gestione-motoabb.firebasestorage.app",
  messagingSenderId:"378476037175",
  appId:"1:378476037175:web:17efeb4f6d350b95c1abb2"
});
var messaging=firebase.messaging();
messaging.onBackgroundMessage(function(p){
  var d=(p&&p.data)||{};
  return self.registration.showNotification(d.title||"Gestione",{
    body:d.body||"",
    icon:"icon-192.png",
    data:{url:d.url||"./"}
  });
});
