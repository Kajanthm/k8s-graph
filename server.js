'use strict';

const express = require('express');
const hbs = require('express-hbs');
const http = require('http');
const app = express();
const server = http.createServer(app);
const io = require('socket.io').listen(server);

const port = 3000;

const masterSize = getEnvVar('masterSize', 15);
const minionSize = getEnvVar('minionSize', 15);
const podSize = getEnvVar('podSize', 15);
const linkSizePodToMinion = getEnvVar('linkSizePodToMinion', 150);
const linkSizeMinionToMaster = getEnvVar('linkSizeMinionToMaster', 250);
const dummyNodes = getEnvVar('dummyNodes', 0);
const namespacesUrl = getEnvVar('namespacesUrl', 'http://127.0.0.1:8001/api/v1/namespaces/');
const nodesApiUrl = getEnvVar('nodesApiUrl', 'http://127.0.0.1:8001/api/v1/nodes');
const pollingIntervalInSeconds = getEnvVar('pollingIntervalInSeconds', 1);

let namespace = "default";
let podsResult;
let nodesResult;
let namespaces;

function getEnvVar(envVar, defaultValue) {
    const value = process.env[envVar];
    return value === undefined ? defaultValue : value;
}

function extractInformation() {
    //Extract master and minions nodes
    let master;
    let minions = nodesResult.items.map(function(item) {
        const conditions = item.status.conditions.find((item) => {return item.type === "Ready"});

        let node  = {
            id: item.metadata.name,
            size: minionSize,
            text: item.metadata.name,
            color: item.metadata.name,
            type: "Node",
            status: conditions.status !== "True" ? "pulse" : ""
        };

        // Looks like this is how we can identify the master
        const isMaster = item.spec.taints;
        // Set master relevant configuration
        if (isMaster) {
            master = item.metadata.name;
            node.type = "Master";
            node.size = masterSize;
        }

        return node;
    });
    if (!master) {
        console.log("Could not identify master node. Please check if k8s update was a breaking change.");
    }

    //Dummy nodes
    let i = 0;
    while (minions.length < dummyNodes) {
        minions.push({id: 'dummy'+i++, size: minionSize, color: 'dummy', type: "Node"})
    }

    //Pods
    const pods = podsResult.items.map(function(item) {
        let status = "";
        if (item.metadata.deletionTimestamp) {
            status = "delete";
        } else if (item.status.phase === "Pending") {
            status = "start";
        } else if (item.status.conditions.find((item) => {return item.type === "Ready" && item.status === "False"})) {
            status = "notReady";
        } else {
            status = "ready"
        }

        const restartCount = item.status.containerStatuses
            .map((item) => item.restartCount)
            .reduce((sum, value) => sum + value);

        return {
            id: item.metadata.name,
            text: item.metadata.name,
            size: podSize,
            color: item.metadata.labels.app === undefined ? item.metadata.labels.run : item.metadata.labels.app,
            status: status,
            type: "Pod",
            restarts: restartCount,
            containers: item.status.containerStatuses
        };
    });

    // Merge minions (also the master node) and pods
    const nodes = minions.concat(pods);
    //Links
    //Pod to minion
    const links = podsResult.items.map(function(item) {
        return {source: item.metadata.name, target: item.spec.nodeName, length: linkSizePodToMinion, dotted: true};
    });
    //Minion to master
    if (master) {
        minions.forEach(function (item) {
            links.push({source: item.id, target: master, length: linkSizeMinionToMaster, dotted: false});
        });
    }

    return {links: links, nodes: nodes};
}

app.use(express.static(__dirname + '/client'));
// Setup
app.engine('hbs', hbs.express4({}));
app.set('view engine', 'hbs');
app.set('views', __dirname + '/client');

fetchNamespaces();

function handleNamespacesCall(res) {
    res.setEncoding('utf8');
    let rawData = '';
    res.on('data', (chunk) => { rawData += chunk; });
    res.on('end', () => {
        try {
            namespaces = JSON.parse(rawData).items.map((item) => item.metadata.name);
        } catch (e) {
            handleError('Unable to fetch namespaces from k8s response.\n'
                + `Error message: ${e.message}\n`
                + `--- response from k8s API call ---\n`
                + `${rawData}\n`
                + `--- response end ---\n`);
        }
    });
}

// Serve
app.get('/', (request, response) => {
    fetchNamespaces();
    response.render('k8s',
        {
            namespaces: namespaces
        });
});

function fetchNamespaces() {
    http.get(namespacesUrl, handleNamespacesCall).on('error', (e) => {
        handleError(`Request to k8s failed.\nError message: ${e.message}`);
    });
}

io.on('connection', (socket) => {
    socket.on('changeNamespace', (newNamespace) => namespace = newNamespace);
    poll();
});

function poll() {
    http.get(`${namespacesUrl}${namespace}/pods`, handlePodsCall).on('error', (e) => {
        handleError(`Request to k8s failed.\nError message: ${e.message}`);
    });
}

function handlePodsCall(res) {
    res.setEncoding('utf8');
    let rawData = '';
    res.on('data', (chunk) => { rawData += chunk; });
    res.on('end', () => {
        try {
            podsResult = JSON.parse(rawData);
            http.get(nodesApiUrl, handleNodesCall).on('error', (e) => {
                handleError(`Request to k8s failed.\nError message: ${e.message}`);
            });
        } catch (e) {
            handleError('Unable to parse and extract information from k8s response.\n'
                + `Error message: ${e.message}\n`
                + `--- response from k8s API call ---\n`
                + `${rawData}\n`
                + `--- response end ---\n`);
        }
    });
}

function handleNodesCall(res) {
    res.setEncoding('utf8');
    let rawData = '';
    res.on('data', (chunk) => { rawData += chunk; });
    res.on('end', () => {
        try {
            nodesResult = JSON.parse(rawData);
            const result = extractInformation();
            io.emit('update', result);
        } catch (e) {
            handleError('Unable to parse and extract information from k8s response.\n'
                + `Error message: ${e.message}\n`
                + `--- response from k8s API call ---\n`
                + `${rawData}\n`
                + `--- response end ---\n`);
        }
    });
}

function handleError(errorMessage) {
    console.error(errorMessage);
    io.emit('error', errorMessage);
}

setInterval(poll, pollingIntervalInSeconds * 1000);

server.listen(port);
console.log('Running on http://localhost:' + port);