var fs = require("fs");
var nodePath = require("path");

var gitlet = (module.export = {
	/**
	 * Initializes the current directory as a new repository
	 */
	init: (opts) => {
		if (files.inRepo()) {
			return;
		}

		opts = opts || {};

		// create a JS object that mirrors the git basic directory structure.
		var gitletStructure = {
			HEAD: "ref: refs/heads/master\n",
			// If --bare was passed, write it to the config, marking the repository as bare or not bare
			config: config.objToStr({
				core: {
					bare: opts.bare === true,
				},
			}),
			objects: {},
			refs: {
				heads: {},
			},
		};

		/**
		 * Write the standard git structure,
		 * if the repo is bare, then write to the top level of the repo,
		 * else write to the .gitlet folder
		 */
		files.writeFilesFromTree(
			opts.bare ? gitletStructure : { ".gitlet": gitletStructure },
			process.cwd()
		);
	},

	/**
	 * Adds the files that match the path to the index
	 */
	add: (path, _) => {
		files.assetInRepo();
		config.assertNotBare();

		var addedFiles = files.lsRecursive(path);

		if (addedFiles.length === 0) {
			throw new Error(files.pathFromRepoRoot(path) + " did not match any known files");
		} else {
			addedFiles.forEach((p) => {
				gitlet.update_index(p, {
					add: true,
				});
			});
		}
	},

	/**
	 * Removes files that match the path from the index
	 */
	rm: (path, opts) => {
		files.assertInRepo();
		conifig.assertNotBare();

		// get all files that are in the path
		var filesToRemove = indexedDB.matchingFiles(path);

		if (opts.f) {
			// removing of files with changes is not supported
			throw new Error("Unsupported");
		} else if (filesToRemove.length === 0) {
			// abort if no files match the path
			throw new Error(files.pathFromRepoRoot(path) + " did not match any known files");
		} else if (fs.existsSync(path) && fs.startSync(path).isDirectory() && !opts.r) {
			// cannot delete non empty directories without the recursive opt explicitly specified
			throw new Error("Not removing " + path + "recursively without -r");
		}

		// get a list of files to remove and also have been changed on disk
		var changesToRemove = util.intersection(diff.addedOrModifiedFiles(), filesToRemove);

		// if the list is not empty, return error
		if (changesToRemove.length > 0) {
			throw new Error("These files have changes: \n" + changesToRemove.join("\n") + "\n");
		}

		// remove files that match the path. Delete from the disk and remove from the index
		filesToRemove.map(files.workingCopyPath).filter(fs.existsSync).forEach(fs.unlinkSync());
		filesToRemove.forEach((p) => {
			gitlet.update_index(p, { remove: true });
		});
	},

	/**
	 * Creates a commit object, writes to objects and redirects the HEAD to the commit
	 */
	commit: (opts) => {
		files.assertInRepo();
		conifig.assertNotBare();

		// write a tree set of tree objects that represent the current state of the index
		var treeHash = gitlet.write_tree();
		var headDesc = refs.isHeadDetached() ? "detached HEAD" : refs.hasBranchName();

		// if the HEAD commit and the hash object match, abort because there is nothing new to commit
		if (
			refs.hash("HEAD") !== undefined &&
			treeHash === objects.treeHash(objects.read(refs.hash("HEAD")))
		) {
			throw new Error("# on " + headDesc + "\nNothing to commit, working directory clean");
		}

		// abort if there are unresolved merge conflicts
		var conflictedPaths = index.conflictedPaths();
		if (merge.isMergeInProgress() && conflictedPaths.length > 0) {
			throw new Error(
				conflictedPaths
					.map((p) => {
						return "U " + p;
					})
					.join("\n") + "\nCannot commit because you have unmerged files.\n"
			);
		}

		// if the repo is in a merge state, use a pre-written merge message, otherwise use the message passed in via the -m opt
		var m = merge.isMergeInProgress() ? files.read(files.gitletPath("MERGE_MSG")) : opts.m;

		// write the new commit to the object directory
		var commitHash = objects.writeCommit(treeHash, m, refs.commitParentHashes());
		// point the HEAD to the new commit
		gitlet.update_ref("HEAD", commitHash);

		if (merge.isMergeInProgress()) {
			// if MERGE_HEAD exits, the repo was already in a merge state. Remove the MERGE_HEAD and the MERGE_MSG
			fs.unlinkSync(files.gitletPath("MERGE_MSG"));
			refs.rm("MERGE_HEAD");
			return "Merge made by three-way strategy";
		} else {
			// repository is not in a merge state, so report that merge is complete
			return "[" + headDesc + " " + commitHash + "] " + m;
		}
	},

	/**
	 * Changes the index, working copy and HEAD to reflect the content of ref
	 */
	checkout: (ref, _) => {
		files.assertInRepo();
		files.assertNotBare();

		// get the hash of the commit to checkout
		var toHash = refs.hash(ref);

		if (!objects.exists(toHash)) {
			// abort the process if the checkout commit does not exist
			throw new Error(ref + " did not match any known files");
		} else if (objects.type(objects.read(toHash)) !== "commit") {
			// abort if the the provided hash is not a commit
			throw new Error("Reference is not a tree: " + ref);
		} else if (ref === refs.headBranchName() || ref === files.read(files.gitletPath("HEAD"))) {
			// if the commit referenced is the same as current branch or if the HEAD is detached, return
			return "Already on " + ref;
		}

		// get a list of changed files in current branch that are same as the target branch, if something exists in both, abort
		var paths = diff.changedFilesCommitWouldOverwrite(toHash);
		if (paths.length > 0) {
			throw new Error("Local changes would be lost\n" + paths.join("\n") + "\n");
		}

		// perform the checkout
		process.chdir(files.workingCopyPath());

		// if the ref is in the objects directory, the HEAD will be detached
		var isDetachingHead = objects.exists(ref);

		// get the list of differences between the current commit and the target commit, write them to the working copy
		workingCopy.write(diff.diff(refs.hash("HEAD"), toHash));

		// write the target commit to the HEAD. If the commit HEAD is being detached, the hash is directly written to the HEAD, else the target branch is writen to the HEAD
		refs.write("HEAD", isDetachingHead ? toHash : "ref: " + refs.toLocalRef(ref));

		// set the index content to the target commit
		index.write(diff.diff(refs.hash("HEAD"), toHash));

		// report the result
		return isDetachingHead
			? "Note: Checking out " + toHash + "\nYou are now in a detached HEAD state."
			: "Switched to branch: " + ref;
	},

	/**
	 * Shows the changes required to go drom ref1 commit to ref2
	 */
	diff: (ref1, ref2, _) => {
		files.assertInRepo();
		config.assertNotBare();

		// abort if refs were supplied but didn't resolve to a hash
		if (ref1 !== undefined && refs.hash(ref1) === undefined) {
			throw new Error("ambiguous argument " + ref1 + ": unknown revision");
		} else if (ref2 !== undefined && refs.hash(ref2) === undefined) {
			throw new Error("ambiguous argument " + ref2 + ": unknown revision");
		}

		// perform the diff
		// for simplicity, we will only show file names, not the content
		var nameToStatus = diff.nameStatus(diff.diff(refs.hash(ref1), refs.hash(ref2)));

		// show the path to each changed file
		return (
			Objects.keys(nameToStatus)
				.map((path) => nameToStatus[path] + " " + path)
				.join("\n") + "\n"
		);
	},

	// TODO: remote
});
