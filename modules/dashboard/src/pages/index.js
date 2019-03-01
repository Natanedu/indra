import React from "react";
import PropTypes from "prop-types";
//import Button from "@material-ui/core/Button";
//import Dialog from "@material-ui/core/Dialog";
//import DialogTitle from "@material-ui/core/DialogTitle";
//import DialogContent from "@material-ui/core/DialogContent";
//import DialogContentText from "@material-ui/core/DialogContentText";
//import DialogActions from "@material-ui/core/DialogActions";
//import Typography from "@material-ui/core/Typography";
import { withStyles } from "@material-ui/core/styles";
import withRoot from "../withRoot";
import Dashboard from "../components/Dashboard";
import Web3 from "web3";

const styles = theme => ({
  root: {
    textAlign: "center",
    paddingTop: theme.spacing.unit * 20
  }
});

class Index extends React.Component {
  constructor(props) {
    super(props);
    const web3 = new Web3(props.ethUrl);
    this.state = {
      web3
    };
  }
  render() {
    const { classes } = this.props;
    const { web3 } = this.state;
    return (
      <div className={classes.root}>
        <Dashboard web3={web3} hubUrl={this.props.hubUrl} />
      </div>
    );
  }
}

Index.propTypes = {
  classes: PropTypes.object.isRequired
};

export default withRoot(withStyles(styles)(Index));