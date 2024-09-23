angular.module("app", []).controller("controller", function($scope, $http){
    //Date.getMonth index to abbriv.
    const abvr = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    //Add leading 0's
    const lead0 = num => num < 10 ? "0" + num : num;
    $scope.round = num => num.toFixed(2);

    const now = Date.now() / 1000;
    const dateDistance = d => {
        let time = now - d.getTime() / 1000;
        const plural = () => time == 1 ? " ago" : "s ago";
        time = Math.floor(time);
        if(time < 60) return time + " second" + plural();
        time /= 60;
        time = Math.floor(time);
        if(time < 60) return time + " minute" + plural();
        time /= 60;
        time = Math.floor(time);
        if(time < 24) return time + " hour" + plural();;
        if(time < 48) return "Yesterday";
        time /= 24;
        time = Math.floor(time);
        if(time < 31) return time + " day" + plural();
        time /= 30;
        time = Math.floor(time);
        if(time < 12) return time + " month" + plural();
        time /= 12;
        time = Math.floor(time);
        return time + " year" + plural();
    };

    const createFilename = ul => {
        const maxlen = 15;
        if(ul.filename.length < maxlen){
            ul.filenameShort = ul.filename;
        }else{
            ul.filenameShort = ul.filename.substring(0, maxlen - 3) + "...";
        }
    }

    $scope.users = {};
    $scope.whoami = undefined;

    $scope.refreshUsers = () => {
        $http({
            method: "GET",
            url: "/juush/users",
        }).then(function(res){
            $scope.users = res.data;
            for(let x of $scope.users){
                if(x._id == localStorage.id){
                    $scope.selected = x;
                    break;
                }
            }

            $scope.$watch("selected", () => {
                if(!$scope.selected) return;
                localStorage.id = $scope.selected._id;
            });
        }, function(res){
            document.innerHTML = "Error";
        });
    };

    Promise.all([
        $http({
            method: "GET",
            url: "/juush/whoami",
        }).then(function(res){
            //undefined => retreiving
            //false => guest user (no uploads)
            //null => multiple identities (???)
            //number => user
            const idens = res.data.length;
            if(idens === 1){
                $scope.whoami = res.data[0];
            }else if(idens === 0){
                $scope.whoami = false;
            }else{
                $scope.whoamiList = res.data;
                $scope.whoami = null;
            }
        }),
        $http({
            method: "GET",
            url: "/juush/isadmin",
        }).then(function(res){
            //Todo handle unknown case
            $scope.admin = res.data == "true";
        }),
    ]).then(() => {
        $scope.refreshUsers();
    });

    $scope.toggleHidden = () => {
        $scope.adminShowHidden = !$scope.adminShowHidden;
    }

    $scope.updateUserpage = () => {
        if(!$scope.selected){
            $scope.uploads = null;
            return;
        }

        const id = $scope.selected._id;
        let url = `/juush/uploads/${id}/${$scope.page}`;
        if($scope.whoami == id || $scope.adminShowHidden){
            url += "?hidden=true";
        }

        $http({method: "GET", url}).then(function(res){
            $scope.uploads = res.data;
            for(let ul of $scope.uploads){
                const mimes = ul.mimetype.split("/");
                if(mimes[0] === "image"){
                    ul.type = "image";
                }else if(mimes[0] === "video"){
                    ul.type = "video";
                }else if(mimes[0] === "audio"){
                    ul.type = "audio";
                }else if(ul.mimetype === "deleted"){
                    ul.type = "deleted";
                }else{
                    ul.type = null;
                }

                const dt = new Date(ul.uploaddate);
                ul.dispDate =
                      abvr[dt.getMonth()] + " "
                    + dt.getDate() + " "
                    + dt.getFullYear() + ", "
                    + lead0(dt.getHours()) + ":"
                    + lead0(dt.getMinutes()) + ":"
                    + lead0(dt.getSeconds());

                ul.timeAgo = dateDistance(dt);

                createFilename(ul);
            }
        }, function(){

        });

    };

    $scope.updateInfo = () => {
        $scope.page = 0;
        $scope.updateUserpage();
        if(!$scope.selected){
            $scope.uinfo = null;
            return;
        }

        const id = $scope.selected._id;
        let url = `/juush/userinfo/${id}`;
        if($scope.admin){
            url += "?key=true";
        }

        $http({method: "GET", url}).then(function(res){
            $scope.uinfo = res.data;
        });
    };

    let apiClosure = function(url, val1, val2, cb, ul, data){
        ul[val1]= true;
        ul[val2] = false;

        $http({
            method: "GET",
            url: "/f/" + ul._id + url + (data ? "/" + data : ""),
        }).then(function(res){
            ul[val1] = false;
            cb(ul, res);
        }, function(err){
            console.log("Fail from " + url);
            ul.err = err.data || err.statusText;

            ul[val1] = false;
        });
    };

    let hidecb = ul => {ul.modifiers.hidden = ul.temphidden;};
    let juushHide   = apiClosure.bind(undefined, "/hide",   "hideprocessing", "hiding", hidecb);
    let juushUnhide = apiClosure.bind(undefined, "/unhide", "hideprocessing", "hiding", hidecb);
    $scope.juushHides = (ul, nowHidden) => {
        ul.temphidden = nowHidden;
        if(nowHidden){
            juushHide(ul);
        }else{
            juushUnhide(ul);
        }
    };

    $scope.juushDelete = apiClosure.bind(undefined, "/delete", "deleteprocessing", "deleting", ul => {
        ul.type = "deleted";
        ul.mimetype = "deleted";
    });

    let juushRename = apiClosure.bind(undefined, "/rename", "renameprocessing", "renaming", (ul, res) => {
        ul.filename = res.data;
        createFilename(ul);
    });

    $scope.juushRename = ul => {
        juushRename(ul, ul.newName);
    };

    $scope.deleteThisUser = () => {
        const sel = $scope.selected;
        if(!sel) return;
        if(!confirm("Are you sure you want to delete " + sel.name)) return;

        $http({
            method: "GET",
            url: "/juush/deluser/" + sel._id,
        }).then(function(res){
            alert("Deleted? " + res.data);
            if(!res.success) return;
            $scope.selected = $scope.users[0];
            $scope.refreshUsers();
        }, function(err){
            alert("Failed to del" + err);
        });
    };

    $scope.changeAutohide = () => {
        console.log($scope.uinfo);
        $scope.uinfo.autohide = !$scope.uinfo.autohide;
        $http({
            method: "GET",
            url: "/juush/usersetting/" + $scope.selected._id + "/autohide/" + $scope.uinfo.autohide,
        }).then(function(res){
            //noop
        }, function(err){
            $scope.uinfo.autohide = !$scope.uinfo.autohide;
            alert("Failed to make user");
        });
    };

    $scope.changeURL = () => {
        let newURL = prompt("Please enter a new domain, or blank for default (john2143.com)");
        if(newURL === "" || newURL == "host"){
            // host: current hostname for upload
            newURL = "host";
        }

        $http({
            method: "GET",
            url: "/juush/usersetting/" + $scope.selected._id + "/customURL/" + newURL,
        }).then(function(res){
            console.log($scope.uinfo.customURL, res);
        }, function(err){
            alert("Failed to change");
        });
    };

    $scope.createNewUser = () => {
        const uname = prompt("username");
        if(!uname) return;

        $http({
            method: "GET",
            url: "/nuser/" + uname,
        }).then(function(res){
            let importer = {
                Name: "John2143",
                RequestType: "POST",
                RequestURL: "https://john2143.com/uf",
                ResponseType: "Text",
                RegexList: [
                    "(.+)"
                ],
                URL: "$regex:1$",
                DeletionURL: "$regex:1$/delete"
            };

            const key = res.data;
            importer.FileFormName = key;
            importer = JSON.stringify(importer);

            $scope.userData = {
                key,
                importer,
            };

            $scope.refreshUsers();
        }, function(err){
            alert("Failed to make user");
        });
    };

    $scope.getwhoamiTitle = id => {
        let titles = {
            undefined: "Loading...",
            false: "Guest user (No uploads)",
        };

        const myid = $scope.whoami;
        if(myid === null) return ($scope.whoamiList.includes(id) ? "This might be you: " : "This is not you, but: ") + "Multiple identities: " + $scope.whoamiList.join(", ");

        let title = titles[myid];
        if(title) return title;
        return id == myid ? "This is you" : "This is not you";
    };

    $scope.$watch("selected", $scope.updateInfo);
    $scope.$watch("page", $scope.updateUserpage);

    $scope.page = 0;
    window.scoop = $scope;
});
